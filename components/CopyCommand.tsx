"use client";
import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }
  return (
    <div className="command-block">
      <code>{command}</code>
      <button className="btn btn-sm" onClick={() => void copy()}>
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      {status === "error" && (
        <span className="copy-error" role="status">
          Select and copy the command.
        </span>
      )}
    </div>
  );
}
