"use client";
// One line for the backend parts of a page when the user isn't signed in yet. Renders nothing
// when the backend isn't configured, so the local-only workspace looks exactly as before.
import { useAccount } from "@/lib/backend/account";
import { Note } from "./ui";

export function AccountNote({ action }: { action: string }) {
  const account = useAccount();
  switch (account.status) {
    case "unavailable":
    case "signed-in":
      return null;
    case "loading":
      return <Note>Checking your wallet…</Note>;
    case "signing":
      return <Note>Waiting for your sign-in signature…</Note>;
    case "error":
      return (
        <Note>
          Sign-in was not completed: {account.error}{" "}
          <button className="w-text-link" onClick={account.signIn}>
            Try again
          </button>
        </Note>
      );
    default:
      return <Note>Sign in with your wallet to {action}.</Note>;
  }
}
