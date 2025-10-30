from flask import Flask, request, jsonify, render_template, redirect, url_for
import json
import os
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///users.db"
db = SQLAlchemy(app)

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
@app.get("/")
def home():
    return "<h1>🍕 Pizza Peppers Server is Running</h1>"


if __name__ == "__main__":
    # Align with dev proxy target
    app.run(host="127.0.0.1", port=5055, debug=True)
