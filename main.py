from dotenv import load_dotenv
load_dotenv()

import os
import sqlite3
import threading
from functools import wraps
from uuid import uuid4
from datetime import timedelta

from pathlib import Path
from flask import Flask, abort, send_file, request, jsonify, render_template, redirect, url_for, session, flash
from groq import Groq
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__, template_folder='.', static_folder='assets')
app.secret_key = os.getenv("FLASK_SECRET_KEY", "secretkey")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=31)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = str(BASE_DIR / "smartechweb.db")
ORDER_FILES_DIR = BASE_DIR / "orderformfiles"

GROQ_CLIENT = Groq(api_key=os.getenv("GROQ_API_KEY"))
ADMIN_MGMT_USERNAME = os.getenv("ADMIN_MGMT_USERNAME")
ADMIN_MGMT_PASSWORD = os.getenv("ADMIN_MGMT_PASSWORD")


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if dashboard_session_is_valid():
            return view(*args, **kwargs)
        return redirect(url_for("dashboard_login"))

    return wrapped


def superadmin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("superadmin_access") is True:
            return view(*args, **kwargs)
        return redirect(url_for("admin_management_login"))

    return wrapped


def dashboard_session_is_valid():
    username = session.get("dashboard_username")

    if not username:
        session.pop("dashboard_admin", None)
        return False

    if username == ADMIN_MGMT_USERNAME and session.get("superadmin_access"):
        session["dashboard_admin"] = True
        return True

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ? LIMIT 1", (username,))
    user = cursor.fetchone()
    conn.close()

    if user:
        session["dashboard_admin"] = True
        return True

    session.pop("dashboard_admin", None)
    session.pop("dashboard_username", None)
    return False


def init_db():
    ORDER_FILES_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS enquiries (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        email TEXT NOT NULL,
                        phone TEXT NOT NULL,
                        message TEXT NOT NULL,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                    )''')
    conn.commit()
    cursor.execute('''CREATE TABLE IF NOT EXISTS orders (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        representative_name TEXT NOT NULL,
                        order_for TEXT NOT NULL,
                        phone TEXT NOT NULL,
                        email TEXT NOT NULL,
                        date TEXT NOT NULL,
                        remark TEXT NOT NULL,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        filename TEXT DEFAULT NULL
                    )''')
    conn.commit()

    cursor.execute('''CREATE TABLE IF NOT EXISTS users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT NOT NULL UNIQUE,
                        password TEXT NOT NULL,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                    )''')
    conn.commit()
    conn.close()

def sqldb():
    db = sqlite3.connect(DB_PATH)
    c = db.cursor()
    return db, c

def order_insert(representative_name, order_for, phone, email, date, remark, filename=None):
    conn, cursor = sqldb()
    cursor.execute('''INSERT INTO orders (representative_name, order_for, phone, email, date, remark, filename) 
                      VALUES (?, ?, ?, ?, ?, ?, ?)''', 
                   (representative_name, order_for, phone, email, date, remark, filename))
    conn.commit()
    conn.close()


def save_order_attachment(uploaded_file):
    if uploaded_file is None or not uploaded_file.filename:
        return None

    original_name = secure_filename(uploaded_file.filename)
    if not original_name:
        return None

    unique_name = f"{uuid4().hex}_{original_name}"
    stored_path = ORDER_FILES_DIR / unique_name
    uploaded_file.save(stored_path)
    return f"orderformfiles/{unique_name}"


def get_order_file_path(order_id):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id, filename FROM orders WHERE id = ? LIMIT 1", (order_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def enquiry_insert(name, email, phone, message):
    conn, cursor = sqldb()
    cursor.execute('''INSERT INTO enquiries (name, email, phone, message) 
                      VALUES (?, ?, ?, ?)''', 
                   (name, email, phone, message))
    conn.commit()
    conn.close()


def fetch_rows(table_name):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        f"SELECT * FROM {table_name} ORDER BY datetime(timestamp) DESC, id DESC"
    )
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def delete_row(table_name, row_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(f"DELETE FROM {table_name} WHERE id = ?", (row_id,))
    conn.commit()
    conn.close()


def fetch_users():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, password, timestamp FROM users ORDER BY datetime(timestamp) DESC, id DESC"
    )
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def get_primary_user_credentials():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT username, password FROM users ORDER BY id ASC LIMIT 1"
    )
    user = cursor.fetchone()
    conn.close()
    return dict(user) if user else None


def add_user(username, password):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        (username, password),
    )
    conn.commit()
    conn.close()


def delete_user(user_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


def render_admin_management_page(*, login_error=None, action_error=None, action_message=None, superadmin_logged_in=False):
    users = fetch_users() if superadmin_logged_in else []
    return render_template(
        "admin-management.html",
        superadmin_logged_in=superadmin_logged_in,
        login_error=login_error,
        action_error=action_error,
        action_message=action_message,
        users=users,
        user_count=len(users),
    )


def authenticate_admin(username, password):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT username, password FROM users WHERE username = ? LIMIT 1",
        (username,),
    )
    user = cursor.fetchone()
    conn.close()

    if not user:
        return False

    return user["password"] == password


def serve_file(relative_path: str):
    file_path = BASE_DIR / relative_path
    if not file_path.is_file():
        abort(404)
    return send_file(file_path)


PAGE_ROUTES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/aichat.html': 'aichat.html',
    '/career.html': 'career.html',
    '/clients.html': 'clients.html',
    '/enquiry.html': 'enquiry.html',
    '/grampanchayat.html': 'grampanchayat.html',
    '/orderform.html': 'orderform.html',
    '/school-management-system.html': 'school-management-system.html',
    '/partials/footer.html': 'partials/footer.html',
    '/partials/top-contact.html': 'partials/top-contact.html',
    '/partials/aichat.html': 'partials/aichat.html',
}


for route, file_name in PAGE_ROUTES.items():
    endpoint = route.strip('/').replace('/', '_').replace('.', '_') or "home"
    endpoint = endpoint.replace('-', '_')

    def threadserve(file_name=file_name):
        def view(file_name=file_name):
            return serve_file(file_name)

        app.add_url_rule(route, endpoint, view)

    threading.Thread(target=threadserve).start()


@app.route('/partials/header.html', methods=['GET'])
def header_partial():
    return render_template(
        "partials/header.html",
        dashboard_link_visible=dashboard_session_is_valid(),
        admin_management_link_visible=session.get("superadmin_access") is True,
    )


@app.route('/dashboard.html', methods=['GET'])
def dashboard():
    is_admin = dashboard_session_is_valid()
    orders = fetch_rows("orders")
    enquiries = fetch_rows("enquiries")
    return render_template(
        "dashboard.html",
        admin_logged_in=is_admin,
        orders=orders,
        enquiries=enquiries,
        order_count=len(orders),
        enquiry_count=len(enquiries),
        latest_order=orders[0] if orders else None,
        latest_enquiry=enquiries[0] if enquiries else None,
    )


@app.route('/dashboard/login', methods=['GET', 'POST'])
def dashboard_login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        is_superadmin = (username == ADMIN_MGMT_USERNAME and password == ADMIN_MGMT_PASSWORD)

        if username and password and (is_superadmin or authenticate_admin(username, password)):
            session.permanent = True
            session["dashboard_admin"] = True
            session["dashboard_username"] = username
            if is_superadmin or username == ADMIN_MGMT_USERNAME:
                session["superadmin_access"] = True
                session["superadmin_username"] = username
            return redirect(url_for("dashboard"))

        flash("Invalid username or password.", "login_error")
        return redirect(url_for("dashboard"))

    return redirect(url_for("dashboard"))


@app.route('/dashboard/logout', methods=['POST'])
def dashboard_logout():
    session.pop("dashboard_admin", None)
    session.pop("dashboard_username", None)
    session.pop("superadmin_access", None)
    session.pop("superadmin_username", None)
    return redirect(url_for("dashboard"))


@app.route('/admin-management.html', methods=['GET'])
def admin_management():
    is_superadmin = session.get("superadmin_access") is True
    return render_admin_management_page(superadmin_logged_in=is_superadmin)


@app.route('/admin-management/login', methods=['GET', 'POST'])
def admin_management_login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if username == ADMIN_MGMT_USERNAME and password == ADMIN_MGMT_PASSWORD:
            session.permanent = True
            session["superadmin_access"] = True
            session["superadmin_username"] = username
            session["dashboard_admin"] = True
            session["dashboard_username"] = username
            return redirect(url_for("admin_management"))

        return render_admin_management_page(
            superadmin_logged_in=False,
            login_error="Invalid super-admin username or password.",
        ), 401

    return render_admin_management_page(superadmin_logged_in=False)


@app.route('/admin-management/logout', methods=['POST'])
def admin_management_logout():
    session.pop("superadmin_access", None)
    session.pop("superadmin_username", None)
    session.pop("dashboard_admin", None)
    session.pop("dashboard_username", None)
    return redirect(url_for("admin_management"))


@app.route('/admin-management/users/add', methods=['POST'])
@superadmin_required
def admin_management_add_user():
    username = request.form.get('username', '').strip()
    password = request.form.get('password', '')

    if not username or not password:
        return render_admin_management_page(
            superadmin_logged_in=True,
            action_error="Username and password are required.",
        ), 400

    try:
        add_user(username, password)
    except sqlite3.IntegrityError:
        return render_admin_management_page(
            superadmin_logged_in=True,
            action_error="That username already exists.",
        ), 409

    return redirect(url_for("admin_management"))


@app.route('/admin-management/users/<int:user_id>/delete', methods=['POST'])
@superadmin_required
def admin_management_delete_user(user_id):
    delete_user(user_id)
    return redirect(url_for("admin_management"))


@app.route('/api/chat', methods=['POST'])
def handle_aimsg():
    txt = ""
    user_input = request.json

    final = []
    msgs = {}
    for x in user_input['messages']:
        msgs = {
            "role": x['role'],
            "content": x['content']
        }
        final.append(msgs)

    with open('content.txt', 'r') as f:
        txt = f.read()

    completion = GROQ_CLIENT.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {
            "role": "system",
            "content": f"{txt}\n\nAnswer the user using the company details above. Keep the reply formal, clear, and plain text only. Do not use markdown."
            }, *final
        ],
        temperature=1,
        max_completion_tokens=1024,
        top_p=1,
        stream=False,
        stop=None
        )

    reply = completion.choices[0].message.content
    return jsonify({"reply": reply})

@app.route('/api/enquiry', methods=['POST'])
def handle_enquiry():
    data = request.json
    name = data.get('name')
    email = data.get('email')
    phone = data.get('mobile')
    message = data.get('message')

    if not all([name, email, phone, message]):
        return jsonify({"error": "All fields are required."}), 400

    enquiry_insert(name, email, phone, message)
    return jsonify({"message": "Enquiry submitted successfully."}), 200

@app.route('/api/order', methods=['POST'])
def handle_order():
    if request.is_json:
        data = request.json or {}
        representative_name = data.get('representative_name')
        order_for = data.get('order_for')
        phone = data.get('phone')
        email = data.get('email')
        date = data.get('date')
        remark = data.get('remark')
        uploaded_file = None
    else:
        data = request.form
        representative_name = data.get('representative_name')
        order_for = data.get('order_for')
        phone = data.get('phone')
        email = data.get('email')
        date = data.get('date')
        remark = data.get('remark')
        uploaded_file = request.files.get('attachment')

    filename = save_order_attachment(uploaded_file)

    if not all([representative_name, order_for, phone, email, date, remark]):
        return jsonify({"error": "All fields are required."}), 400

    order_insert(representative_name, order_for, phone, email, date, remark, filename)
    return jsonify({"message": "Order submitted successfully."}), 200


@app.route('/api/dashboard/orders', methods=['GET'])
@admin_required
def get_orders():
    return jsonify({"orders": fetch_rows("orders")})


@app.route('/api/dashboard/enquiries', methods=['GET'])
@admin_required
def get_enquiries():
    return jsonify({"enquiries": fetch_rows("enquiries")})


@app.route('/dashboard/orders/<int:order_id>/delete', methods=['POST'])
@admin_required
def delete_order_route(order_id):
    row = get_order_file_path(order_id)
    if row and row.get("filename"):
        file_path = BASE_DIR / row["filename"]
        if file_path.is_file():
            file_path.unlink()
    delete_row("orders", order_id)
    return redirect(url_for("dashboard"))


@app.route('/dashboard/enquiries/<int:enquiry_id>/delete', methods=['POST'])
@admin_required
def delete_enquiry_route(enquiry_id):
    delete_row("enquiries", enquiry_id)
    return redirect(url_for("dashboard"))


@app.route('/dashboard/orders/<int:order_id>/file', methods=['GET'])
@admin_required
def download_order_file(order_id):
    row = get_order_file_path(order_id)
    if not row or not row.get("filename"):
        abort(404)

    relative_path = row["filename"]
    file_path = BASE_DIR / relative_path
    if not file_path.is_file():
        abort(404)

    return send_file(file_path, as_attachment=True, download_name=file_path.name)


init_db()


if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000)
