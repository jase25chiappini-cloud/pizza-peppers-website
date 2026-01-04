from flask import Flask, request, jsonify, render_template, redirect, url_for, send_from_directory, Response
import json
import os
import re
import requests
from pathlib import Path
try:
    # Load .env when running via `python app.py` (flask run does this automatically)
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:
    pass
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///users.db"
db = SQLAlchemy(app)

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
    phone = db.Column(db.String(20), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)


with app.app_context():
    db.create_all()


@app.post("/register")
def register():
    data = request.get_json()
    phone, password = data.get("phone"), data.get("password")
    if not phone or not password:
        return jsonify({"error": "Missing phone or password"}), 400
    if User.query.filter_by(phone=phone).first():
        return jsonify({"error": "User already exists"}), 400
    u = User(phone=phone)
    u.set_password(password)
    db.session.add(u)
    db.session.commit()
    return jsonify({"message": "Registered successfully"}), 200


@app.post("/login")
def login():
    data = request.get_json()
    phone, password = data.get("phone"), data.get("password")
    user = User.query.filter_by(phone=phone).first()
    if user and user.check_password(password):
        return jsonify({"logged_in": True, "user": {"phone": user.phone}})
    return jsonify({"logged_in": False, "error": "Invalid credentials"}), 401


def _load_menu_json():
    """
    Reads a menu JSON and returns a dict. Tries common locations.
    Supports either a normalized shape: { "data": { "categories": [...], "products": [...] } }
    or a catalog-like shape with top-level categories/products.
    """
    candidate_paths = [
        # common spots in this repo
        os.path.join(os.getcwd(), "server", "static", "menu.json"),
        os.path.join(os.getcwd(), "static", "menu.json"),
        os.path.join(os.getcwd(), "public", "menu.json"),
        os.path.join(os.getcwd(), "src", "data", "menu.json"),
        os.path.join(os.getcwd(), "menu.json"),  # repo root (present in this project)
    ]
    for p in candidate_paths:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    raise FileNotFoundError("menu.json not found in expected locations.")


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
        # 1) Prefer live menu via POS API when key is provided
        pos_key = os.getenv('POS_API_KEY')
        pos_url = os.getenv('POS_MENU_URL', 'https://pizzapepperspos.onrender.com/public/menu')
        raw = None
        if pos_key:
            try:
                res = requests.get(
                    pos_url,
                    headers={
                        'Accept': 'application/json',
                        # common patterns; server may use one of these
                        'x-api-key': pos_key,
                        'Authorization': f'Bearer {pos_key}',
                    },
                    timeout=12,
                )
                if res.ok:
                    raw = res.json()
                else:
                    # fall back to local if remote returns non-OK
                    raw = None
            except Exception:
                raw = None

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
