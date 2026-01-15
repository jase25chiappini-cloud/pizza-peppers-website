import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Admin Panel Page
 * Requires backend endpoints:
 *  - GET    /admin/users
 *  - PATCH  /admin/users/:id
 *  - POST   /admin/users/:id/set-password
 *
 * Auth:
 *  - Authorization: Bearer <token>
 *
 * Token lookup (supports future + fallback):
 *  - localStorage.pp_session_v1 as { token, user }
 *  - localStorage.pp_auth_token_v1 as string
 */
export default function AdminPanelPage() {
  const normalizeBase = (raw) => {
    const s = String(raw || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  };

  const PP_MENU_BASE_URL = normalizeBase(import.meta.env.VITE_PP_MENU_BASE_URL);
  const PP_POS_BASE_URL = normalizeBase(
    import.meta.env.VITE_PP_POS_BASE_URL || import.meta.env.VITE_PP_RENDER_BASE_URL,
  );

  // In dev, allow relative calls (so Vite proxy / same-origin can work)
  const API_BASE = import.meta.env.DEV ? "" : (PP_MENU_BASE_URL || PP_POS_BASE_URL);

  const [session, setSession] = useState(() => readSession());
  const token = session?.token || readAuthTokenFallback();
  const actorRole = session?.user?.role || "customer";

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);

  const filtered = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const phone = String(u.phone || "").toLowerCase();
      const name = String(u.displayName || "").toLowerCase();
      const role = String(u.role || "").toLowerCase();
      return (
        phone.includes(q) ||
        name.includes(q) ||
        role.includes(q) ||
        String(u.id).includes(q)
      );
    });
  }, [users, query]);

  const refresh = async () => {
    setErr("");
    setOk("");

    if (!API_BASE && !import.meta.env.DEV) {
      setErr(
        "Missing API base env var (set VITE_PP_MENU_BASE_URL or VITE_PP_POS_BASE_URL). Requests will try same-origin and likely fail.",
      );
    }
    if (!token) {
      setErr("No admin session token found. Log in as staff/admin first.");
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/admin/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401)
        throw new Error("Unauthorized (token invalid/expired).");
      if (res.status === 403)
        throw new Error("Forbidden (your account is not staff/admin).");
      if (!res.ok || !data?.ok)
        throw new Error(data?.error || "Failed to load users.");

      setUsers(Array.isArray(data.users) ? data.users : []);
      setOk(`Loaded ${Array.isArray(data.users) ? data.users.length : 0} users.`);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // keep session fresh if something else updates localStorage
    const t = setInterval(() => setSession(readSession()), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEdit = (u) => {
    setEditUser(u);
    setEditOpen(true);
  };

  const closeEdit = () => {
    setEditOpen(false);
    setEditUser(null);
  };

  const onSaved = async () => {
    await refresh();
    closeEdit();
  };

  return (
    <div style={{ padding: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Admin Panel</div>
            <div style={{ opacity: 0.8, fontSize: 12 }}>
              Staff tools - users, roles, profile edits, password reset
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="input"
              placeholder="Search phone / name / role / id"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ minWidth: 260 }}
            />
            <button className="btn" onClick={refresh} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>

        {err ? (
          <div className="mb-3" style={{ marginTop: 12, color: "var(--danger)" }}>
            {err}
          </div>
        ) : null}

        {ok ? (
          <div
            className="mb-3"
            style={{ marginTop: 12, color: "rgba(190,242,100,0.95)" }}
          >
            {ok}
          </div>
        ) : null}

        {!token ? (
          <div style={{ marginTop: 12, opacity: 0.85 }}>
            No token found. Once you implement server login, store it in{" "}
            <code>pp_session_v1</code> as <code>{"{ token, user }"}</code>.
          </div>
        ) : null}

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ textAlign: "left", opacity: 0.9 }}>
                <th style={th}>ID</th>
                <th style={th}>Phone</th>
                <th style={th}>Name</th>
                <th style={th}>Role</th>
                <th style={th}>Active</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr
                  key={u.id}
                  style={{ borderTop: "1px solid rgba(148,163,184,0.18)" }}
                >
                  <td style={tdMono}>{u.id}</td>
                  <td style={tdMono}>{u.phone}</td>
                  <td style={td}>{u.displayName || ""}</td>
                  <td style={tdMono}>{u.role}</td>
                  <td style={tdMono}>{u.isActive ? "Yes" : "No"}</td>
                  <td style={td}>
                    <button className="btn" onClick={() => openEdit(u)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}

              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 14, opacity: 0.75 }}>
                    No users match your search.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {editOpen && editUser ? (
        <EditUserModal
          apiBase={API_BASE}
          token={token}
          actorRole={actorRole}
          user={editUser}
          onClose={closeEdit}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function EditUserModal({ apiBase, token, actorRole, user, onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [isActive, setIsActive] = useState(!!user.isActive);
  const [role, setRole] = useState(user.role || "customer");

  const [newPassword, setNewPassword] = useState("");

  const canEditRole = actorRole === "admin";

  const saveProfile = async () => {
    setErr("");
    setOk("");

    try {
      setSaving(true);
      const body = {
        displayName,
        isActive,
      };
      if (canEditRole) body.role = role;

      const res = await fetch(`${apiBase}/admin/users/${user.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401)
        throw new Error("Unauthorized (token invalid/expired).");
      if (res.status === 403) throw new Error("Forbidden (not permitted).");
      if (!res.ok || !data?.ok)
        throw new Error(data?.error || "Save failed.");

      setOk("Saved.");
      await onSaved();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const setPassword = async () => {
    setErr("");
    setOk("");

    if (!newPassword || newPassword.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }

    try {
      setSaving(true);
      const res = await fetch(`${apiBase}/admin/users/${user.id}/set-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401)
        throw new Error("Unauthorized (token invalid/expired).");
      if (res.status === 403) throw new Error("Forbidden (not permitted).");
      if (!res.ok || !data?.ok)
        throw new Error(data?.error || "Password reset failed.");

      setNewPassword("");
      setOk("Password updated.");
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-content"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: 720, padding: 18 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Edit User</div>
            <div style={{ opacity: 0.8, fontSize: 12 }}>
              #{user.id} - {user.phone}
            </div>
          </div>
          <button className="btn" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>

        {err ? (
          <div style={{ marginTop: 12, color: "var(--danger)" }}>{err}</div>
        ) : null}
        {ok ? (
          <div style={{ marginTop: 12, color: "rgba(190,242,100,0.95)" }}>
            {ok}
          </div>
        ) : null}

        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
          <div>
            <div style={label}>Display name</div>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <div style={label}>Active</div>
            <select
              className="input"
              value={isActive ? "yes" : "no"}
              onChange={(e) => setIsActive(e.target.value === "yes")}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
            <div style={label}>Role</div>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={!canEditRole}
              title={!canEditRole ? "Only admin can change roles" : ""}
            >
              <option value="customer">customer</option>
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
            {!canEditRole ? (
              <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>
                Only <b>admin</b> can change roles.
              </div>
            ) : null}
          </div>

          <div />
        </div>

        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <button className="btn primary" onClick={saveProfile} disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>

        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: "1px solid rgba(148,163,184,0.18)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>
            Reset password
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              className="input"
              type="password"
              placeholder="New password (min 6 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={{ flex: 1, minWidth: 240 }}
            />
            <button className="btn" onClick={setPassword} disabled={saving}>
              Set password
            </button>
          </div>
          <div style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
            This updates the server-side hash (customers can log in immediately).
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function readSession() {
  try {
    const raw = localStorage.getItem("pp_session_v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    // supports future format: { token, user }
    if (parsed && typeof parsed === "object" && (parsed.token || parsed.user))
      return parsed;

    return null;
  } catch {
    return null;
  }
}

function readAuthTokenFallback() {
  try {
    const raw = localStorage.getItem("pp_auth_token_v1");
    if (!raw) return null;
    return String(raw || "").trim() || null;
  } catch {
    return null;
  }
}

const th = { padding: "10px 8px" };
const td = { padding: "10px 8px", verticalAlign: "top" };
const tdMono = {
  ...td,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};
const label = { opacity: 0.85, fontSize: 12, marginBottom: 6 };
