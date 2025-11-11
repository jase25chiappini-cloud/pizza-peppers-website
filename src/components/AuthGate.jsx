import React from "react";
import { useAuth } from "../App";

export default function AuthGate({ children }) {
  const { loading } = useAuth();

  if (loading) {
    return null;
  }

  return children;
}
