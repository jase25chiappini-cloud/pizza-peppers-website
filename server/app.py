from flask import Flask, request, jsonify
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


# 👇 Move this ABOVE the "if __name__ == '__main__':" line
@app.get("/")
def home():
    return "<h1>🍕 Pizza Peppers Server is Running</h1>"


if __name__ == "__main__":
    app.run(port=5000, debug=True)
