from flask import Flask, request, jsonify, render_template, redirect, url_for, send_from_directory, Response
import json
import os
import re
import requests
from pathlib import Path
from datetime import datetime, timedelta
import secrets
import time
from collections import defaultdict, deque
from functools import wraps
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
import firebase_admin
from firebase_admin import credentials, auth as fb_admin_auth
try:
    # Load .env when running via `python app.py` (flask run does this automatically)
    from dotenv import load_dotenv  # type: ignore
    _env_dir = Path(__file__).resolve().parent
    load_dotenv(_env_dir / ".env")
    load_dotenv(_env_dir / ".env.local")
except Exception:
    pass
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS

app = Flask(__name__, static_folder=None)
ALLOWED_ORIGINS = [
    o.strip()
    for o in (os.getenv("POS_ALLOWED_ORIGINS") or "").split(",")
    if o.strip()
]
# If no allowlist provided, default to local dev only
if not ALLOWED_ORIGINS:
    ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS}},
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "x-api-key"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)

app.config["SECRET_KEY"] = os.getenv("POS_SECRET_KEY", "dev-change-me-now")
TOKEN_SALT = "pp_auth_v1"
TOKEN_MAX_AGE_SECONDS = int(os.getenv("POS_TOKEN_MAX_AGE", "259200"))  # 3 days
IS_PROD = (os.getenv("FLASK_ENV") or "").lower() == "production" or (os.getenv("RENDER") == "true")

def _serializer():
    return URLSafeTimedSerializer(app.config["SECRET_KEY"], salt=TOKEN_SALT)

def make_token(payload: dict) -> str:
    return _serializer().dumps(payload)

def read_token(token: str) -> dict | None:
    try:
        return _serializer().loads(token, max_age=TOKEN_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None

def get_bearer_token() -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

_rate = defaultdict(lambda: deque())

def rate_limit(key: str, limit: int, window_sec: int) -> bool:
    now = time.time()
    q = _rate[key]
    while q and (now - q[0]) > window_sec:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True

def client_ip():
    # Render sets X-Forwarded-For
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "unknown"

def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        tok = get_bearer_token()
        data = read_token(tok) if tok else None
        if not data or not data.get("uid"):
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        u = User.query.get(int(data["uid"]))
        if not u or not u.is_active:
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        request.pp_user = u
        return fn(*args, **kwargs)
    return wrapper

def staff_required(fn):
    @wraps(fn)
    @auth_required
    def wrapper(*args, **kwargs):
        u = request.pp_user
        if u.role not in ("staff", "admin"):
            return jsonify({"ok": False, "error": "Forbidden"}), 403
        return fn(*args, **kwargs)
    return wrapper

def _parse_emails(env_name: str) -> set[str]:
    raw = (os.getenv(env_name) or "").strip()
    if not raw:
        return set()
    return {e.strip().lower() for e in raw.split(",") if e.strip()}

ADMIN_EMAILS = _parse_emails("POS_ADMIN_EMAILS")
STAFF_EMAILS = _parse_emails("POS_STAFF_EMAILS")

def role_for_email(email: str) -> str:
    e = (email or "").strip().lower()
    if e in ADMIN_EMAILS:
        return "admin"
    if e in STAFF_EMAILS:
        return "staff"
    return "customer"

def init_firebase_admin():
    """
    Set env FIREBASE_ADMIN_CREDENTIALS to either:
      1) a JSON string, OR
      2) a filesystem path to the serviceAccountKey.json
    """
    cred_raw = (os.getenv("FIREBASE_ADMIN_CREDENTIALS") or "").strip()
    if not cred_raw:
        print("[auth] FIREBASE_ADMIN_CREDENTIALS not set -> /auth/firebase will fail")
        return

    try:
        if cred_raw.startswith("{"):
            cred_obj = json.loads(cred_raw)
            cred = credentials.Certificate(cred_obj)
        else:
            cred = credentials.Certificate(cred_raw)
        firebase_admin.initialize_app(cred)
        print("[auth] firebase-admin initialized")
    except Exception as e:
        print("[auth] firebase-admin init failed:", e)

# init once
if not firebase_admin._apps:
    init_firebase_admin()

# --- DB path (Render persistent disk friendly) ---
DB_PATH = os.getenv("POS_DB_PATH", "").strip()
if DB_PATH:
    # Ensure parent directory exists (Render disk mount, etc.)
    try:
        parent = os.path.dirname(DB_PATH)
        if parent:
            os.makedirs(parent, exist_ok=True)
    except Exception as e:
        print("[db] failed to create DB dir:", e)

    app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
else:
    # local/dev fallback
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///users.db"

app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)

def normalize_phone(s: str) -> str:
    if not s:
        return ""
    x = re.sub(r"[^\d+]", "", s.strip())
    if x.startswith("00"):
        x = "+" + x[2:]

    # AU: 04xxxxxxxx -> +614xxxxxxxx
    if re.fullmatch(r"04\d{8}", x):
        x = "+61" + x[1:]

    # AU: 4xxxxxxxx -> +614xxxxxxxx
    if re.fullmatch(r"4\d{8}", x):
        x = "+61" + x

    # 61xxxxxxxxx -> +61xxxxxxxxx
    if re.fullmatch(r"61\d+", x):
        x = "+" + x

    # raw digits -> +digits
    if not x.startswith("+") and re.fullmatch(r"\d+", x):
        x = "+" + x

    return x

BOOTSTRAP_ADMIN_PHONE_RAW = (os.getenv("POS_BOOTSTRAP_ADMIN_PHONE") or "").strip()
BOOTSTRAP_ADMIN_PHONE = normalize_phone(BOOTSTRAP_ADMIN_PHONE_RAW)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "static" / "uploads"

# Optional persistent uploads directory (Render Disk or shared volume)
DB_DIR = Path(os.getenv("DB_DIR", str(BASE_DIR / "data"))).resolve()
PERSIST_UPLOAD_DIR = DB_DIR / "uploads"

# Secret Files live at /etc/secrets/<filename> on Render Web Services
SECRETS_DIR = Path("/etc/secrets")

def _read_secret_file(name: str) -> str:
    try:
        p = SECRETS_DIR / name
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""

def _images_api_key() -> str:
    # Prefer env var, then secret file
    return (
        os.getenv("POS_IMAGES_API_KEY")
        or _read_secret_file("brother_images_key")
        or ""
    )

def _images_upstream_base() -> str:
    # If your brother gave you a dedicated images URL, set POS_IMAGES_URL
    # Otherwise use POS_BASE_URL as base and append /static/uploads
    explicit = (os.getenv("POS_IMAGES_URL") or "").strip()
    if explicit:
        return explicit.rstrip("/")
    base = (os.getenv("POS_BASE_URL") or "").strip().rstrip("/")
    return f"{base}/static/uploads" if base else ""

# Check persistent first, then repo bundled
UPLOAD_DIRS = [PERSIST_UPLOAD_DIR, UPLOAD_DIR]

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)

    # Local customer identity (optional)
    phone = db.Column(db.String(32), unique=True, nullable=True)
    password_hash = db.Column(db.String(256), nullable=True)

    # Google identity (optional)
    email = db.Column(db.String(255), unique=True, nullable=True)
    firebase_uid = db.Column(db.String(128), unique=True, nullable=True)

    display_name = db.Column(db.String(80), default="", nullable=False)
    role = db.Column(db.String(16), default="customer", nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    last_login_at = db.Column(db.DateTime, nullable=True)

    reset_code_hash = db.Column(db.String(256), nullable=True)
    reset_expires_at = db.Column(db.DateTime, nullable=True)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        if not self.password_hash:
            return False
        return check_password_hash(self.password_hash, pw)

    def set_reset_code(self, code: str, minutes: int = 10):
        self.reset_code_hash = generate_password_hash(code)
        self.reset_expires_at = datetime.utcnow() + timedelta(minutes=minutes)

    def check_reset_code(self, code: str) -> bool:
        if not self.reset_code_hash or not self.reset_expires_at:
            return False
        if datetime.utcnow() > self.reset_expires_at:
            return False
        return check_password_hash(self.reset_code_hash, code)


class AdminAudit(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    actor_user_id = db.Column(db.Integer, nullable=False)
    target_user_id = db.Column(db.Integer, nullable=True)
    action = db.Column(db.String(64), nullable=False)
    detail = db.Column(db.String(512), nullable=True)
    ip = db.Column(db.String(64), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


def audit(actor_id: int, action: str, target_id: int | None = None, detail: str = ""):
    a = AdminAudit(
        actor_user_id=actor_id,
        target_user_id=target_id,
        action=action,
        detail=detail[:512],
        ip=client_ip(),
    )
    db.session.add(a)
    db.session.commit()


def should_bootstrap_admin(phone_raw: str, phone_normalized: str) -> bool:
    if not BOOTSTRAP_ADMIN_PHONE_RAW and not BOOTSTRAP_ADMIN_PHONE:
        return False
    if phone_normalized != BOOTSTRAP_ADMIN_PHONE and phone_raw != BOOTSTRAP_ADMIN_PHONE_RAW:
        return False
    existing_admin = User.query.filter(User.role.in_(["admin", "staff"])).first()
    return existing_admin is None


with app.app_context():
    db.create_all()


@app.post("/register")
def register():
    data = request.get_json() or {}
    ip = client_ip()
    if not rate_limit(f"auth:{ip}", limit=20, window_sec=60):
        return jsonify({"ok": False, "error": "Too many requests"}), 429
    phone_raw = (data.get("phone") or "").strip()
    phone = normalize_phone(phone_raw)
    password = data.get("password") or ""
    display_name = (data.get("displayName") or "").strip()

    if not phone or not password:
        return jsonify({"ok": False, "error": "Missing phone or password"}), 400
    if User.query.filter_by(phone=phone).first():
        return jsonify({"ok": False, "error": "User already exists"}), 400
    role = "customer"
    if should_bootstrap_admin(phone_raw, phone):
        role = "admin"
        if not display_name:
            display_name = "Admin"
    u = User(phone=phone, display_name=display_name, role=role)
    u.set_password(password)
    db.session.add(u)
    db.session.commit()
    token = make_token({"uid": u.id, "role": u.role})
    return jsonify({
        "ok": True,
        "token": token,
        "user": {"id": u.id, "phone": u.phone, "email": u.email, "displayName": u.display_name, "role": u.role},
    }), 200


@app.post("/login")
def login():
    data = request.get_json() or {}
    phone_raw = (data.get("phone") or "").strip()
    phone = normalize_phone(phone_raw)
    password = data.get("password") or ""

    ip = client_ip()
    if not rate_limit(f"auth:{ip}", limit=20, window_sec=60):
        return jsonify({"ok": False, "error": "Too many requests"}), 429
    if phone and not rate_limit(f"login:{phone}", limit=8, window_sec=300):
        return jsonify({"ok": False, "error": "Too many login attempts"}), 429

    candidates = [phone]
    if phone_raw and phone_raw not in candidates:
        candidates.append(phone_raw)
    u = User.query.filter(User.phone.in_(candidates)).first()
    if not u or not u.is_active or not u.check_password(password):
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401

    if u.role == "customer" and should_bootstrap_admin(phone_raw, phone):
        u.role = "admin"
        if not u.display_name:
            u.display_name = "Admin"

    u.last_login_at = datetime.utcnow()
    u.updated_at = datetime.utcnow()
    db.session.commit()

    token = make_token({"uid": u.id, "role": u.role})
    return jsonify({
        "ok": True,
        "token": token,
        "user": {"id": u.id, "phone": u.phone, "email": u.email, "displayName": u.display_name, "role": u.role},
    }), 200


@app.post("/auth/firebase")
def auth_firebase():
    if not firebase_admin._apps:
        return jsonify({"ok": False, "error": "firebase-admin not configured"}), 500

    data = request.get_json() or {}
    id_token = data.get("idToken") or ""
    if not id_token:
        return jsonify({"ok": False, "error": "Missing idToken"}), 400

    try:
        decoded = fb_admin_auth.verify_id_token(id_token, check_revoked=True)
    except Exception:
        return jsonify({"ok": False, "error": "Invalid token"}), 401

    fb_uid = decoded.get("uid")
    email = (decoded.get("email") or "").strip().lower()
    name = (decoded.get("name") or decoded.get("displayName") or "").strip()

    if not fb_uid:
        return jsonify({"ok": False, "error": "Token missing uid"}), 400

    # Role based on allowlist env vars
    role = role_for_email(email)

    # Upsert user
    u = None
    if email:
        u = User.query.filter_by(email=email).first()
    if not u:
        u = User.query.filter_by(firebase_uid=fb_uid).first()

    if not u:
        u = User(email=email or None, firebase_uid=fb_uid, display_name=name or "", role=role)
        db.session.add(u)
    else:
        u.firebase_uid = fb_uid
        if email:
            u.email = email
        if name and not u.display_name:
            u.display_name = name
        # If this login is allowlisted staff/admin, bump role upwards
        if role in ("staff", "admin") and u.role == "customer":
            u.role = role
        if role == "admin" and u.role != "admin":
            u.role = "admin"

    u.last_login_at = datetime.utcnow()
    u.updated_at = datetime.utcnow()
    db.session.commit()

    token = make_token({"uid": u.id, "role": u.role})
    return jsonify({
        "ok": True,
        "token": token,
        "user": {"id": u.id, "phone": u.phone, "email": u.email, "displayName": u.display_name, "role": u.role},
    }), 200


@app.get("/me")
@auth_required
def me():
    u = request.pp_user
    return jsonify({"ok": True, "user": {
        "id": u.id, "phone": u.phone, "displayName": u.display_name, "role": u.role
    }})


@app.put("/me")
@auth_required
def update_me():
    u = request.pp_user
    data = request.get_json() or {}
    if "displayName" in data:
        dn = (data.get("displayName") or "").strip()
        u.display_name = dn
    u.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True, "user": {
        "id": u.id, "phone": u.phone, "displayName": u.display_name, "role": u.role
    }})


@app.post("/auth/request-reset")
def request_reset():
    data = request.get_json() or {}
    ip = client_ip()
    if not rate_limit(f"auth:{ip}", limit=20, window_sec=60):
        return jsonify({"ok": False, "error": "Too many requests"}), 429
    phone = (data.get("phone") or "").strip()
    if not phone:
        return jsonify({"error": "Missing phone"}), 400

    u = User.query.filter_by(phone=phone).first()
    if not u or not u.is_active:
        return jsonify({"ok": True}), 200

    code = f"{secrets.randbelow(1000000):06d}"
    u.set_reset_code(code, minutes=10)
    u.updated_at = datetime.utcnow()
    db.session.commit()

    if os.getenv("POS_RETURN_RESET_CODE", "1") == "1":
        return jsonify({"ok": True, "devCode": code}), 200

    return jsonify({"ok": True}), 200


@app.post("/auth/reset")
def reset_password():
    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    code = (data.get("code") or "").strip()
    new_pw = data.get("newPassword") or ""

    if not phone or not code or not new_pw:
        return jsonify({"error": "Missing fields"}), 400
    if len(new_pw) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    u = User.query.filter_by(phone=phone).first()
    if not u or not u.is_active or not u.check_reset_code(code):
        return jsonify({"error": "Invalid code"}), 400

    u.set_password(new_pw)
    u.reset_code_hash = None
    u.reset_expires_at = None
    u.updated_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"ok": True}), 200


@app.get("/admin/users")
@staff_required
def admin_users():
    users = User.query.order_by(User.created_at.desc()).limit(500).all()
    return jsonify({"ok": True, "users": [
        {"id": u.id, "phone": u.phone, "email": u.email, "displayName": u.display_name, "role": u.role, "isActive": u.is_active}
        for u in users
    ]})


@app.patch("/admin/users/<int:user_id>")
@staff_required
def admin_update_user(user_id: int):
    actor = request.pp_user
    u = User.query.get_or_404(user_id)
    data = request.get_json() or {}
    changes = []

    if "displayName" in data:
        new_display_name = (data.get("displayName") or "").strip()
        if new_display_name != u.display_name:
            changes.append(f"displayName:{u.display_name}->{new_display_name}")
        u.display_name = new_display_name

    if "isActive" in data:
        new_is_active = bool(data.get("isActive"))
        if new_is_active != u.is_active:
            changes.append(f"isActive:{u.is_active}->{new_is_active}")
        u.is_active = new_is_active

    if "role" in data:
        if actor.role != "admin":
            return jsonify({"ok": False, "error": "Forbidden"}), 403
        role = (data.get("role") or "").strip()
        if role not in ("customer", "staff", "admin"):
            return jsonify({"ok": False, "error": "Invalid role"}), 400
        if role != u.role:
            changes.append(f"role:{u.role}->{role}")
        u.role = role

    u.updated_at = datetime.utcnow()
    db.session.commit()
    if changes:
        audit(actor.id, "update_user", target_id=u.id, detail="; ".join(changes))
    return jsonify({"ok": True})


@app.post("/admin/users/<int:user_id>/set-password")
@staff_required
def admin_set_password(user_id: int):
    u = User.query.get_or_404(user_id)
    data = request.get_json() or {}
    pw = data.get("newPassword") or ""
    if len(pw) < 6:
        return jsonify({"ok": False, "error": "Password must be at least 6 characters"}), 400
    u.set_password(pw)
    u.updated_at = datetime.utcnow()
    db.session.commit()
    audit(request.pp_user.id, "set_password", target_id=user_id)
    return jsonify({"ok": True})


@app.post("/admin/bootstrap")
def admin_bootstrap():
    if IS_PROD and os.getenv("POS_ALLOW_BOOTSTRAP_IN_PROD", "0") != "1":
        return jsonify({"ok": False, "error": "Forbidden"}), 403
    setup_key = os.getenv("POS_ADMIN_SETUP_KEY", "")
    data = request.get_json() or {}
    if not setup_key or data.get("setupKey") != setup_key:
        return jsonify({"ok": False, "error": "Forbidden"}), 403

    phone = (data.get("phone") or "").strip()
    pw = data.get("password") or ""
    if not phone or len(pw) < 6:
        return jsonify({"error": "Invalid fields"}), 400

    existing_admin = User.query.filter(User.role.in_(["admin", "staff"])).first()
    if existing_admin:
        return jsonify({"error": "Already bootstrapped"}), 400

    u = User.query.filter_by(phone=phone).first()
    if u:
        u.role = "admin"
        u.set_password(pw)
    else:
        u = User(phone=phone, display_name="Admin", role="admin")
        u.set_password(pw)
        db.session.add(u)

    db.session.commit()
    return jsonify({"ok": True}), 200


def _load_menu_json():
    """
    Reads menu JSON and returns a dict. Deterministic paths for Render.
    Priority:
      1) POS_MENU_FILE env (absolute or relative to this file)
      2) ./menu.json next to this app.py
      3) ../menu.json (repo root)
      4) legacy cwd-based paths
    """
    base_dir = Path(__file__).resolve().parent

    env_path = (os.getenv("POS_MENU_FILE") or "").strip()
    if env_path:
        p = Path(env_path)
        if not p.is_absolute():
            p = (base_dir / p).resolve()
        if p.exists():
            with p.open("r", encoding="utf-8") as f:
                return json.load(f)

    candidate_paths = [
        base_dir / "menu.json",
        base_dir.parent / "menu.json",
        base_dir / "static" / "menu.json",
        base_dir / "public" / "menu.json",

        # legacy fallbacks (last)
        Path(os.getcwd()) / "server" / "static" / "menu.json",
        Path(os.getcwd()) / "static" / "menu.json",
        Path(os.getcwd()) / "public" / "menu.json",
        Path(os.getcwd()) / "src" / "data" / "menu.json",
        Path(os.getcwd()) / "menu.json",
    ]

    for p in candidate_paths:
        if p.exists():
            with p.open("r", encoding="utf-8") as f:
                return json.load(f)

    raise FileNotFoundError(
        f"menu.json not found. Tried: {', '.join(str(p) for p in candidate_paths)}"
    )


def _normalize_to_minimal_catalog(payload: dict) -> dict:
    """
    Ensure outgoing shape is exactly { "data": { "categories": [...], "products": [...] } }.
    """
    if isinstance(payload, dict) and "data" in payload:
        data = payload.get("data") or {}
        if isinstance(data, dict) and "categories" in data and "products" in data:
            return {"data": {"categories": data["categories"], "products": data["products"]}}
    categories = payload.get("categories", []) if isinstance(payload, dict) else []
    products = payload.get("products", []) if isinstance(payload, dict) else []
    return {"data": {"categories": categories, "products": products}}


@app.get("/public/menu")
def public_menu():
    """
    Frontend expects: GET /public/menu -> 200 + { data: { categories, products } }
    Return helpful JSON on failure.
    """
    try:
        # 1) Prefer live menu via POS_MENU_URL (key optional)
        pos_key = (os.getenv("POS_API_KEY") or "").strip()
        pos_url = (os.getenv("POS_MENU_URL") or "").strip()

        raw = None
        if pos_url:
            try:
                headers = {"Accept": "application/json"}
                if pos_key:
                    # send both header casings + bearer (covers most servers)
                    headers["X-API-Key"] = pos_key
                    headers["x-api-key"] = pos_key
                    headers["Authorization"] = f"Bearer {pos_key}"

                res = requests.get(pos_url, headers=headers, timeout=12)
                if res.ok:
                    raw = res.json()
                else:
                    return jsonify({
                        "error": "Upstream menu fetch failed",
                        "upstream_status": res.status_code,
                        "upstream_body": (res.text or "")[:200],
                        "pos_url": pos_url,
                    }), 502
            except Exception as e:
                return jsonify({
                    "error": "Upstream menu fetch exception",
                    "pos_url": pos_url,
                    "detail": f"{e.__class__.__name__}: {e}",
                }), 502

        # 2) Fallback to local file(s) when live fetch is unavailable
        if raw is None:
            raw = _load_menu_json()

        out = _normalize_to_minimal_catalog(raw)
        data = out.get("data", {})
        if not isinstance(data.get("categories"), list) or not isinstance(data.get("products"), list):
            return jsonify({"error": "Menu payload missing categories/products list."}), 500
        return jsonify(out), 200
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    except json.JSONDecodeError:
        return jsonify({"error": "menu.json is not valid JSON."}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected server error: {e.__class__.__name__}: {e}"}), 500


# 👇 Move this ABOVE the "if __name__ == '__main__':" line (already is)
# Helper utilities for resilient image lookup
def _norm_key(stem: str) -> str:
    """Normalize a filename stem to alphanumerics for fuzzy matching."""
    return re.sub(r"[^a-z0-9]", "", (stem or "").lower())


def _pick_best_match(request_stem: str, files: list[str]) -> str | None:
    """
    Pick the best filename match for a requested stem by normalizing out symbols/spaces.
    Prefers exact stem matches, then filenames without spaces/parentheses, then shortest.
    """
    req_key = _norm_key(request_stem)
    candidates: list[str] = []
    for f in files:
        stem, ext = os.path.splitext(f)
        if ext.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        if _norm_key(stem) == req_key:
            candidates.append(f)

    if not candidates:
        return None

    def score(fname: str):
        stem = os.path.splitext(fname)[0].lower()
        return (
            0 if stem == request_stem.lower() else 1,
            1 if any(ch in fname for ch in (" ", "(", ")")) else 0,
            len(fname),
            fname.lower(),
        )

    candidates.sort(key=score)
    return candidates[0]


def _list_images_payload() -> dict:
    """Return a JSON-friendly listing of available image files."""
    dirs = [d for d in UPLOAD_DIRS if d.is_dir()]
    if not dirs:
        return {"ok": True, "images": []}

    images = []
    seen = set()
    for d in dirs:
        for name in sorted(os.listdir(d)):
            ext = Path(name).suffix.lower()
            if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            if name in seen:
                continue
            seen.add(name)
            images.append({"filename": name, "url": f"/api/images/{name}"})
    return {"ok": True, "images": images}


@app.route("/public/images", methods=["GET"])
def public_images_index():
    """
    Public, no-auth listing of available images for the website.
    """
    payload = _list_images_payload()
    resp = jsonify(payload)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/static/uploads/<path:filename>", methods=["GET"])
def public_static_uploads(filename: str):
    # Reuse the same logic as /api/images
    return api_images_file(filename)


@app.route("/api/images/<path:filename>", methods=["GET"])
def api_images_file(filename: str):
    """
    Serve image files with a best-effort fallback for naming mismatches.
    If not found locally, proxy from upstream POS server using images API key (if provided).
    """
    safe = os.path.basename(filename)

    # 1) Try direct file in our upload dirs (persistent first, then repo bundled)
    for d in UPLOAD_DIRS:
        direct_path = d / safe
        if direct_path.is_file():
            return send_from_directory(d, safe)

    # 2) Try fuzzy match across upload dirs
    req_stem = Path(safe).stem
    for d in UPLOAD_DIRS:
        try:
            files = os.listdir(d)
        except Exception:
            continue

        alt = _pick_best_match(req_stem, files)
        if alt:
            return send_from_directory(d, alt)

    # 3) Upstream fallback (brother server)
    upstream_base = _images_upstream_base()
    if upstream_base:
        try:
            upstream_url = f"{upstream_base}/{safe}"
            key = _images_api_key()

            headers = {}
            # Apply key if we have one (supports both common patterns)
            if key:
                headers["x-api-key"] = key
                headers["Authorization"] = f"Bearer {key}"

            r = requests.get(upstream_url, headers=headers, timeout=12)
            if r.ok and r.content:
                ct = r.headers.get("content-type") or "application/octet-stream"
                resp = Response(r.content, status=200, mimetype=ct)
                resp.headers["Cache-Control"] = "public, max-age=86400"  # 24h
                resp.headers["Access-Control-Allow-Origin"] = "*"
                return resp
        except Exception:
            pass

    return jsonify({"ok": False, "error": "not found"}), 404


@app.get("/")
def home():
    return "<h1>🍕 Pizza Peppers Server is Running</h1>"


if __name__ == "__main__":
    # Align with dev proxy target
    app.run(host="127.0.0.1", port=5055, debug=True)
