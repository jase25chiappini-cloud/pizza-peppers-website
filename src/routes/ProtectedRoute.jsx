import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../App";

export default function ProtectedRoute({ children }) {
  const { currentUser, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return null;
  }

  if (!currentUser) {
    console.warn("[PP][RouteGuard] redirecting to /login from", location.pathname);
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
