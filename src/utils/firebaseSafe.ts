import { auth as firebaseAuth } from "../firebase";

export function getFirebase() {
  const auth = firebaseAuth ?? null;
  const ready = !!auth;
  const user = auth?.currentUser ?? null;
  return { ready, auth, user };
}

export function currentUserOrNull() {
  return getFirebase().user;
}
