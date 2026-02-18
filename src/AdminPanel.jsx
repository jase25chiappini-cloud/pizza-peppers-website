
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./AdminPanel.css";

const PAGE_SIZES = [10, 25, 50, 100];
const ROLE_FILTERS = ["all", "customer", "staff", "admin"];
const STATUS_FILTERS = ["all", "active", "inactive"];

const FEATURE_FLAGS_UPDATED_EVENT = "pp-featureflags-updated";
const FEATURE_LOYALTY_ENABLED_KEY = "pp_feature_loyalty_enabled";
// Hard gate: only admins may view this page.
const REQUIRED_ADMIN_ROLE = "admin";

// Extra safety: auto-lock the admin page after inactivity.
// (Backend auth still must enforce role/permissions.)
const ADMIN_IDLE_LOGOUT_MS = 10 * 60 * 1000;

function clearLocalAdminSession() {
  try {
    localStorage.removeItem("pp_session_v1");
  } catch {}
  try {
    localStorage.removeItem("pp_auth_token_v1");
  } catch {}
}

function AdminLockedScreen({ reason = "" }) {
  return (
    <div className="admin-root">
      <div className="admin-shell">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <div className="admin-adminpill">Admin</div>
            <div>
              <div className="admin-topbar-title">Access required</div>
              <div className="admin-topbar-sub">This page is restricted to admins only.</div>
            </div>
          </div>
          <div className="admin-topbar-right">
            <button
              className="admin-btn admin-btn-ghost"
              onClick={() => (window.location.href = "/")}
              type="button"
            >
              Back to POS
            </button>
          </div>
        </header>

        <div className="admin-card admin-controls" style={{ padding: 16 }}>
          {reason ? (
            <div className="admin-banner error" style={{ marginBottom: 10 }}>
              {reason}
            </div>
          ) : null}

          <div className="admin-muted" style={{ marginBottom: 14 }}>
            If you are an admin, sign in first.
          </div>

          <div className="admin-action-row" style={{ justifyContent: "flex-start" }}>
            <button
              className="admin-btn admin-btn-primary"
              onClick={() => (window.location.href = "/login")}
              type="button"
            >
              Go to login
            </button>
            <button
              className="admin-btn admin-btn-ghost"
              onClick={() => {
                clearLocalAdminSession();
                window.location.href = "/";
              }}
              type="button"
            >
              Clear local session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function readLoyaltyFlag() {
  try {
    const v = localStorage.getItem(FEATURE_LOYALTY_ENABLED_KEY);
    if (v == null) return true;
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

function writeLoyaltyFlag(next) {
  try {
    localStorage.setItem(FEATURE_LOYALTY_ENABLED_KEY, next ? "1" : "0");
  } catch {}
  try {
    window.dispatchEvent(new Event(FEATURE_FLAGS_UPDATED_EVENT));
  } catch {}
}

export default function AdminPanelPage() {
  const MENU_BASE = (import.meta.env.VITE_PP_MENU_BASE_URL || "").replace(/\/+$/, "");
  const RAW_API_BASE = (import.meta.env.VITE_PP_AUTH_BASE_URL || MENU_BASE || "").replace(
    /\/+$/,
    "",
  );
  const API_BASE = RAW_API_BASE;

  const [session, setSession] = useState(() => readSession());
  const token = session?.token || readAuthTokenFallback();
  const actorRole = session?.user?.role || "customer";
  const isAuthorized = !!token && actorRole === REQUIRED_ADMIN_ROLE;
  const canEditRole = isAuthorized;
  const canManageUsers = isAuthorized;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState(null);

  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState("id");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(() => readLoyaltyFlag());

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);

  const refresh = async () => {
    setErr("");
    setOk("");
    if (!isAuthorized) return;

    if (!API_BASE && !import.meta.env.DEV) {
      setErr(
        "Missing API base env var. Set VITE_PP_AUTH_BASE_URL (or VITE_PP_MENU_BASE_URL).",
      );
      return;
    }
    if (!token) {
      setErr("No admin session token found. Log in as staff/admin first.");
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/admin/users`, {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await readJsonSafe(res);

      if (res.status === 401 || res.status === 403) {
        clearLocalAdminSession();
        setSession(null);
        setUsers([]);
        setSelectedIds(new Set());
        throw new Error(
          res.status === 401
            ? "Unauthorized (token invalid/expired)."
            : "Forbidden (your account is not admin).",
        );
      }
      if (!res.ok || !data?.ok)
        throw new Error(data?.error || "Failed to load users.");

      const nextUsers = Array.isArray(data.users) ? data.users : [];
      setUsers(nextUsers);
      setLastLoadedAt(new Date());
      setOk(`Loaded ${nextUsers.length} users.`);
      setSelectedIds((prev) => {
        const allowed = new Set(nextUsers.map((u) => u.id));
        const next = new Set();
        prev.forEach((id) => {
          if (allowed.has(id)) next.add(id);
        });
        return next;
      });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const sync = () => setSession(readSession());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const body = document.body;
    const key = "__ppScrollLockCount";
    const count = (window[key] || 0) + 1;
    window[key] = count;
    if (count === 1) body.classList.add("pp-scroll-locked");
    return () => {
      const next = Math.max(0, (window[key] || 0) - 1);
      window[key] = next;
      if (next === 0) body.classList.remove("pp-scroll-locked");
    };
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, token]);

  useEffect(() => {
    if (!isAuthorized) return;

    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "pointerdown"];
    events.forEach((ev) => window.addEventListener(ev, touch, { passive: true }));

    const t = window.setInterval(() => {
      if (Date.now() - last > ADMIN_IDLE_LOGOUT_MS) {
        clearLocalAdminSession();
        window.location.href = "/";
      }
    }, 15 * 1000);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, touch));
      window.clearInterval(t);
    };
  }, [isAuthorized]);

  useEffect(() => {
    setPage(1);
  }, [query, roleFilter, statusFilter, pageSize]);

  if (!isAuthorized) {
    return (
      <AdminLockedScreen
        reason={
          token
            ? "Your account is not permitted to view the admin console."
            : "You are not signed in as an admin."
        }
      />
    );
  }

  const stats = useMemo(() => {
    const total = users.length;
    const active = users.filter((u) => u.isActive).length;
    const inactive = total - active;
    const admin = users.filter((u) => u.role === "admin").length;
    const staff = users.filter((u) => u.role === "staff").length;
    const customer = users.filter((u) => u.role === "customer").length;
    return { total, active, inactive, admin, staff, customer };
  }, [users]);

  const filtered = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== "all" && String(u.role) !== roleFilter) return false;
      if (statusFilter !== "all") {
        const isActive = !!u.isActive;
        if (statusFilter === "active" && !isActive) return false;
        if (statusFilter === "inactive" && isActive) return false;
      }
      if (!q) return true;
      const phone = String(u.phone || "").toLowerCase();
      const name = String(u.displayName || "").toLowerCase();
      const role = String(u.role || "").toLowerCase();
      const email = String(u.email || "").toLowerCase();
      return (
        phone.includes(q) ||
        name.includes(q) ||
        role.includes(q) ||
        email.includes(q) ||
        String(u.id).includes(q)
      );
    });
  }, [users, query, roleFilter, statusFilter]);

  const sorted = useMemo(() => {
    const pick = (u) => {
      if (sortKey === "name") return String(u.displayName || "").toLowerCase();
      if (sortKey === "phone") return String(u.phone || "");
      if (sortKey === "role") return String(u.role || "");
      if (sortKey === "active") return u.isActive ? 1 : 0;
      if (sortKey === "email") return String(u.email || "");
      return Number(u.id || 0);
    };

    const list = [...filtered];
    list.sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      if (av === bv) return 0;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return sortDir === "asc" ? -1 : 1;
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const startIdx = (currentPage - 1) * pageSize;
  const paged = sorted.slice(startIdx, startIdx + pageSize);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const selectedCount = selectedIds.size;
  const isAllSelected =
    paged.length > 0 && paged.every((u) => selectedIds.has(u.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        paged.forEach((u) => next.delete(u.id));
      } else {
        paged.forEach((u) => next.add(u.id));
      }
      return next;
    });
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir("asc");
  };

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

  const updateUser = async (userId, body) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
      method: "PATCH",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await readJsonSafe(res);
    if (res.status === 401 || res.status === 403) {
      clearLocalAdminSession();
      setSession(null);
      setUsers([]);
      setSelectedIds(new Set());
      throw new Error(
        res.status === 401
          ? "Unauthorized (token invalid/expired)."
          : "Forbidden (not permitted).",
      );
    }
    if (!res.ok || !data?.ok)
      throw new Error(data?.error || "Save failed.");
    return data;
  };

  const toggleActive = async (u) => {
    setErr("");
    setOk("");
    try {
      await updateUser(u.id, { isActive: !u.isActive });
      setOk(`${u.isActive ? "Deactivated" : "Activated"} ${labelUser(u)}.`);
      await refresh();
    } catch (e) {
      setErr(String(e?.message || e));
    }
  };

  const applyBulkAction = async () => {
    setErr("");
    setOk("");

    if (!selectedIds.size) {
      setErr("Select at least one user.");
      return;
    }
    if (!bulkAction) {
      setErr("Select a bulk action first.");
      return;
    }

    const body = {};
    if (bulkAction === "activate") body.isActive = true;
    if (bulkAction === "deactivate") body.isActive = false;
    if (bulkAction === "role_customer") body.role = "customer";
    if (bulkAction === "role_staff") body.role = "staff";
    if (bulkAction === "role_admin") body.role = "admin";

    const ids = Array.from(selectedIds);
    try {
      setBulkLoading(true);
      let okCount = 0;
      for (const id of ids) {
        await updateUser(id, body);
        okCount += 1;
      }
      setOk(`Updated ${okCount} users.`);
      clearSelection();
      await refresh();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBulkLoading(false);
    }
  };

  const exportCsv = () => {
    const rows = users.map((u) => ({
      id: u.id,
      phone: u.phone || "",
      email: u.email || "",
      displayName: u.displayName || "",
      role: u.role || "",
      isActive: u.isActive ? "true" : "false",
    }));
    const header = ["id", "phone", "email", "displayName", "role", "isActive"];
    const csv = [header.join(",")]
      .concat(rows.map((r) => header.map((h) => csvEscape(String(r[h] || ""))).join(",")))
      .join("\n");
    downloadCsv(csv, "pp-users.csv");
  };

  return (
    <div className="admin-root">
      <div className="admin-shell">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <div className="admin-adminpill">Admin</div>
            <div>
              <div className="admin-topbar-title">User management</div>
              <div className="admin-topbar-sub">
                Roles, access, passwords, and status
              </div>
            </div>
          </div>

          <div className="admin-topbar-right">
            <div className="admin-whoami">
              <div className="admin-whoami-main">
                <div className="admin-whoami-name">
                  {session?.user?.displayName || session?.user?.phone || "User"}
                </div>
                <div className="admin-whoami-role">
                  Signed in as <b>{actorRole}</b>
                </div>
              </div>
              <div className={`admin-role-badge role-${actorRole}`}>{actorRole}</div>
            </div>

            <button
              className="admin-btn admin-btn-ghost"
              onClick={() => (window.location.href = "/")}
              title="Back to POS"
            >
              Back to POS
            </button>

            <button className="admin-btn admin-btn-ghost" onClick={exportCsv}>
              Export CSV
            </button>

            <button className="admin-btn" onClick={refresh} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>

            <button
              className="admin-btn admin-btn-primary"
              onClick={() => setCreateOpen(true)}
              disabled={!canManageUsers}
            >
              New user
            </button>

            <button
              className="admin-btn admin-btn-danger"
              onClick={() => {
                clearLocalAdminSession();
                window.location.href = "/";
              }}
              title="Sign out of admin"
            >
              Sign out
            </button>
          </div>
        </header>

        <section className="admin-workspace">
          {/* Controls row (full width) */}
          <section className="admin-card admin-panel-card">
            <div className="admin-panel-left">
              <div className="admin-side-title">Overview</div>
              <div className="admin-stats admin-stats-inline">
                <StatCard label="Total" value={stats.total} />
                <StatCard label="Active" value={stats.active} accent="good" />
                <StatCard label="Inactive" value={stats.inactive} accent="warn" />
                <StatCard label="Admins" value={stats.admin} accent="accent" />
                <StatCard label="Staff" value={stats.staff} accent="accent" />
                <StatCard label="Customers" value={stats.customer} />
              </div>

              <div className="admin-featureflags">
                <div className="admin-side-title" style={{ marginTop: 14 }}>
                  Feature flags
                </div>

                <div className="admin-flag-row">
                  <div>
                    <div className="admin-flag-name">Loyalty program</div>
                    <div className="admin-flag-sub">
                      Show/hide Loyalty in header + mobile footer
                    </div>
                  </div>

                  <button
                    className={[
                      "admin-btn",
                      loyaltyEnabled ? "admin-btn-primary" : "admin-btn-ghost",
                    ].join(" ")}
                    onClick={() => {
                      const next = !loyaltyEnabled;
                      setLoyaltyEnabled(next);
                      writeLoyaltyFlag(next);
                    }}
                    type="button"
                    disabled={!canManageUsers}
                    title={!canManageUsers ? "Staff/Admin only" : "Toggle loyalty feature"}
                  >
                    {loyaltyEnabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

              {selectedCount > 0 ? (
                <div className="admin-bulk-bar" style={{ marginTop: 12 }}>
                  <div className="admin-bulk-info">{selectedCount} selected</div>
                  <select
                    className="admin-select"
                    value={bulkAction}
                    onChange={(e) => setBulkAction(e.target.value)}
                  >
                    <option value="">Bulk actions</option>
                    <option value="activate">Set active</option>
                    <option value="deactivate">Set inactive</option>
                    {canEditRole ? (
                      <>
                        <option value="role_customer">Set role: customer</option>
                        <option value="role_staff">Set role: staff</option>
                        <option value="role_admin">Set role: admin</option>
                      </>
                    ) : null}
                  </select>
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={applyBulkAction}
                    disabled={bulkLoading}
                  >
                    {bulkLoading ? "Applying..." : "Apply"}
                  </button>
                  <button className="admin-btn admin-btn-ghost" onClick={clearSelection}>
                    Clear
                  </button>
                </div>
              ) : null}
            </div>

            <div className="admin-panel-right">
              <div className="admin-side-title">Filters</div>

              <div className="admin-control-group">
                <label className="admin-label">Search</label>
                <input
                  className="admin-input"
                  placeholder="Search phone, name, email, role, or id"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              <div className="admin-panel-row">
                <div className="admin-control-group">
                  <label className="admin-label">Role</label>
                  <div className="admin-chip-row">
                    {ROLE_FILTERS.map((role) => (
                      <button
                        key={role}
                        className={roleFilter === role ? "admin-chip is-active" : "admin-chip"}
                        onClick={() => setRoleFilter(role)}
                      >
                        {role}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="admin-control-group">
                  <label className="admin-label">Status</label>
                  <div className="admin-chip-row">
                    {STATUS_FILTERS.map((status) => (
                      <button
                        key={status}
                        className={statusFilter === status ? "admin-chip is-active" : "admin-chip"}
                        onClick={() => setStatusFilter(status)}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="admin-panel-row">
                <div className="admin-control-group" style={{ minWidth: 180 }}>
                  <label className="admin-label">Page size</label>
                  <select
                    className="admin-select"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size} per page
                      </option>
                    ))}
                  </select>
                </div>

                <div className="admin-control-group" style={{ minWidth: 180 }}>
                  <label className="admin-label">Last refresh</label>
                  <div className="admin-muted">
                    {lastLoadedAt ? lastLoadedAt.toLocaleTimeString() : "Not loaded"}
                  </div>
                </div>

                <div className="admin-control-group" style={{ minWidth: 220 }}>
                  <label className="admin-label">Sort</label>
                  <div className="admin-sort-row">
                    <button className={sortKey === "id" ? "admin-chip is-active" : "admin-chip"} onClick={() => toggleSort("id")}>id</button>
                    <button className={sortKey === "name" ? "admin-chip is-active" : "admin-chip"} onClick={() => toggleSort("name")}>name</button>
                    <button className={sortKey === "role" ? "admin-chip is-active" : "admin-chip"} onClick={() => toggleSort("role")}>role</button>
                    <button className={sortKey === "active" ? "admin-chip is-active" : "admin-chip"} onClick={() => toggleSort("active")}>active</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Users table (full width) */}
          <section className="admin-table-card">
            <div className="admin-table-header">
              <div className="admin-table-title">Users</div>
              <div className="admin-table-meta">
                {loading ? (
                  "Loading..."
                ) : (
                  <>
                    Showing {sorted.length ? startIdx + 1 : 0}-
                    {Math.min(startIdx + pageSize, sorted.length)} of {sorted.length}
                  </>
                )}
              </div>
            </div>

            {err ? (
              <div className="admin-banner error" style={{ margin: "12px 14px 0" }}>
                {err}
              </div>
            ) : null}
            {ok ? (
              <div className="admin-banner ok" style={{ margin: "10px 14px 0" }}>
                {ok}
              </div>
            ) : null}

            <div className="admin-table-wrap" style={{ marginTop: 10 }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th className="admin-th admin-check">
                      <input
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th className="admin-th" onClick={() => toggleSort("id")}>
                      ID
                    </th>
                    <th className="admin-th" onClick={() => toggleSort("phone")}>
                      Phone
                    </th>
                    <th className="admin-th" onClick={() => toggleSort("name")}>
                      Name
                    </th>
                    <th className="admin-th col-email" onClick={() => toggleSort("email")}>
                      Email
                    </th>
                    <th className="admin-th" onClick={() => toggleSort("role")}>
                      Role
                    </th>
                    <th className="admin-th" onClick={() => toggleSort("active")}>
                      Status
                    </th>
                    <th className="admin-th admin-actions" style={{ cursor: "default" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((u) => (
                    <tr key={u.id} className="admin-tr">
                      <td className="admin-td admin-check">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(u.id)}
                          onChange={() => toggleSelect(u.id)}
                        />
                      </td>
                      <td className="admin-td admin-mono">{u.id}</td>
                      <td className="admin-td admin-mono">
                        {u.phone || "-"}
                      </td>
                      <td className="admin-td">
                        <div className="admin-user">
                          <div className="admin-user-name">
                            {u.displayName || "Unnamed"}
                          </div>
                          {session?.user?.id === u.id ? (
                            <div className="admin-user-tag">You</div>
                          ) : null}
                        </div>
                      </td>
                      <td className="admin-td col-email">{u.email || "-"}</td>
                      <td className="admin-td">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="admin-td">
                        <StatusBadge active={!!u.isActive} />
                      </td>
                      <td className="admin-td admin-actions">
                        <button
                          className="admin-btn admin-btn-ghost"
                          onClick={() => openEdit(u)}
                        >
                          Edit
                        </button>
                        <button
                          className={
                            u.isActive
                              ? "admin-btn admin-btn-danger"
                              : "admin-btn admin-btn-good"
                          }
                          onClick={() => toggleActive(u)}
                        >
                          {u.isActive ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  ))}

                  {paged.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="admin-empty">
                        No users match your filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="admin-pagination">
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => setPage(1)}
                disabled={currentPage === 1}
              >
                First
              </button>
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Prev
              </button>
              <div className="admin-page-indicator">
                Page {currentPage} of {pageCount}
              </div>
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={currentPage === pageCount}
              >
                Next
              </button>
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => setPage(pageCount)}
                disabled={currentPage === pageCount}
              >
                Last
              </button>
            </div>
          </section>
        </section>
      </div>

      {editOpen && editUser ? (
        <EditUserModal
          apiBase={API_BASE}
          token={token}
          onAuthFailure={() => {
            clearLocalAdminSession();
            window.location.href = "/login";
          }}
          actorRole={actorRole}
          user={editUser}
          onClose={closeEdit}
          onSaved={onSaved}
        />
      ) : null}

      {createOpen ? (
        <CreateUserModal
          apiBase={API_BASE}
          token={token}
          canEditRole={canEditRole}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function StatCard({ label, value, accent = "default" }) {
  return (
    <div className={`admin-stat admin-stat-${accent}`}>
      <div className="admin-stat-label">{label}</div>
      <div className="admin-stat-value">{value}</div>
    </div>
  );
}

function RoleBadge({ role }) {
  const safe = role || "customer";
  return <span className={`admin-role-badge role-${safe}`}>{safe}</span>;
}

function StatusBadge({ active }) {
  return (
    <span className={active ? "admin-status active" : "admin-status inactive"}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function EditUserModal({ apiBase, token, actorRole, user, onClose, onSaved, onAuthFailure }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [isActive, setIsActive] = useState(!!user.isActive);
  const [role, setRole] = useState(user.role || "customer");
  const [newPassword, setNewPassword] = useState("");

  const canEditRole = actorRole === "admin";

  useEffect(() => {
    setDisplayName(user.displayName || "");
    setIsActive(!!user.isActive);
    setRole(user.role || "customer");
    setNewPassword("");
    setErr("");
    setOk("");
  }, [user]);

  const saveProfile = async (overrides = {}) => {
    setErr("");
    setOk("");

    try {
      setSaving(true);
      const body = {
        displayName,
        isActive,
      };
      if (canEditRole) body.role = overrides.role ?? role;

      const res = await fetch(`${apiBase}/admin/users/${user.id}`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await readJsonSafe(res);
      if (res.status === 401 || res.status === 403) {
        clearLocalAdminSession();
        if (onAuthFailure) onAuthFailure();
        return;
      }
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
      const res = await fetch(
        `${apiBase}/admin/users/${user.id}/set-password`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ newPassword }),
        },
      );
      const data = await readJsonSafe(res);
      if (res.status === 401 || res.status === 403) {
        clearLocalAdminSession();
        if (onAuthFailure) onAuthFailure();
        return;
      }
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
    <div className="admin-modal-backdrop" onMouseDown={onClose}>
      <div
        className="admin-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="admin-drawer-header">
          <div>
            <div className="admin-drawer-title">Edit user</div>
            <div className="admin-drawer-sub">
              #{user.id} - {user.phone || "no phone"}
            </div>
          </div>
          <button className="admin-btn admin-btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {err ? <div className="admin-banner error">{err}</div> : null}
        {ok ? <div className="admin-banner ok">{ok}</div> : null}

        <div className="admin-drawer-section">
          <div className="admin-section-title">Profile</div>
          <div className="admin-form-grid">
            <div>
              <label className="admin-label">Display name</label>
              <input
                className="admin-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div>
              <label className="admin-label">Status</label>
              <select
                className="admin-select"
                value={isActive ? "active" : "inactive"}
                onChange={(e) => setIsActive(e.target.value === "active")}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="admin-label">Role</label>
              <select
                className="admin-select"
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
                <div className="admin-muted">
                  Only admin can change roles.
                </div>
              ) : null}
            </div>
            <div>
              <label className="admin-label">Email</label>
              <div className="admin-readonly">{user.email || "-"}</div>
            </div>
          </div>

          <div className="admin-action-row">
            <button
              className="admin-btn admin-btn-primary"
              onClick={() => saveProfile()}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
            {canEditRole ? (
              <>
                <button
                  className="admin-btn"
                  onClick={() => saveProfile({ role: "staff" })}
                  disabled={saving || role === "staff"}
                >
                  Make staff
                </button>
                <button
                  className="admin-btn"
                  onClick={() => saveProfile({ role: "admin" })}
                  disabled={saving || role === "admin"}
                >
                  Make admin
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="admin-drawer-section">
          <div className="admin-section-title">Reset password</div>
          <div className="admin-inline">
            <input
              className="admin-input"
              type="password"
              placeholder="New password (min 6 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="admin-btn admin-btn-ghost"
              onClick={setPassword}
              disabled={saving}
            >
              Set password
            </button>
          </div>
          <div className="admin-muted">
            This updates the server-side hash (customers can log in immediately).
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CreateUserModal({ apiBase, token, canEditRole, onClose, onCreated }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("customer");
  const [isActive, setIsActive] = useState(true);

  const createUser = async () => {
    setErr("");
    setOk("");

    const normalized = normalizePhone(phone);
    if (!normalized) {
      setErr("Enter a valid phone.");
      return;
    }
    if (!password || password.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }

    try {
      setSaving(true);
      const res = await fetch(`${apiBase}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalized,
          password,
          displayName: displayName || "",
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.ok)
        throw new Error(data?.error || "Create user failed.");

      const created = data.user;
      const patch = {};
      if (!isActive) patch.isActive = false;
      if (canEditRole && role) patch.role = role;

      if (Object.keys(patch).length) {
        const resPatch = await fetch(`${apiBase}/admin/users/${created.id}`, {
          method: "PATCH",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(patch),
        });
        const patchData = await readJsonSafe(resPatch);
        if (resPatch.status === 401 || resPatch.status === 403) {
          clearLocalAdminSession();
          window.location.href = "/login";
          return;
        }
        if (!resPatch.ok || !patchData?.ok)
          throw new Error(patchData?.error || "Role update failed.");
      }

      setOk("User created.");
      await onCreated();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="admin-modal-backdrop" onMouseDown={onClose}>
      <div className="admin-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <div>
            <div className="admin-drawer-title">Create user</div>
            <div className="admin-drawer-sub">
              Phone login account with optional role.
            </div>
          </div>
          <button className="admin-btn admin-btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {err ? <div className="admin-banner error">{err}</div> : null}
        {ok ? <div className="admin-banner ok">{ok}</div> : null}

        <div className="admin-form-grid">
          <div>
            <label className="admin-label">Phone</label>
            <input
              className="admin-input"
              placeholder="e.g. 04xxxxxxxx or +614xxxxxxxx"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="admin-label">Display name</label>
            <input
              className="admin-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <label className="admin-label">Password</label>
            <input
              className="admin-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="admin-label">Status</label>
            <select
              className="admin-select"
              value={isActive ? "active" : "inactive"}
              onChange={(e) => setIsActive(e.target.value === "active")}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label className="admin-label">Role</label>
            <select
              className="admin-select"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={!canEditRole}
            >
              <option value="customer">customer</option>
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
            {!canEditRole ? (
              <div className="admin-muted">Only admin can assign roles.</div>
            ) : null}
          </div>
        </div>

        <div className="admin-action-row">
          <button
            className="admin-btn admin-btn-primary"
            onClick={createUser}
            disabled={saving}
          >
            {saving ? "Creating..." : "Create user"}
          </button>
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

async function readJsonSafe(res) {
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { ok: false, error: txt ? txt.slice(0, 180) : `HTTP ${res.status}` };
  }
}

function normalizePhone(s) {
  if (!s) return "";
  let x = String(s).trim();
  x = x.replace(/[^\d+]/g, "");
  if (x.startsWith("00")) x = "+" + x.slice(2);
  if (/^04\d{8}$/.test(x)) x = "+61" + x.slice(1);
  if (/^4\d{8}$/.test(x)) x = "+61" + x;
  if (/^61\d+$/.test(x)) x = "+" + x;
  if (!x.startsWith("+") && /^\d+$/.test(x)) x = "+" + x;
  return x;
}

function csvEscape(v) {
  if (v.includes("\"") || v.includes(",") || v.includes("\n")) {
    return `"${v.replace(/\"/g, "\"\"")}"`;
  }
  return v;
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function labelUser(u) {
  return u.displayName || u.phone || `User ${u.id}`;
}
