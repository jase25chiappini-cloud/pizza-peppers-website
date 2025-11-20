const runBtn = document.getElementById("btnRun");
const resetBtn = document.getElementById("btnReset");
const statusText = document.getElementById("statusText");
const logArea = document.getElementById("logArea");
const inputA = document.getElementById("inputA");
const inputB = document.getElementById("inputB");
const modeSelect = document.getElementById("mode");

function setBusy(busy) {
  if (!runBtn || !statusText) return;
  runBtn.disabled = busy;
  runBtn.textContent = busy ? "Running..." : "Run Function";
  statusText.textContent = busy ? "Working..." : "Ready";
}

function resetFields() {
  if (inputA) inputA.value = "";
  if (inputB) inputB.value = "";
  if (modeSelect) modeSelect.value = "balanced";
  if (logArea) logArea.textContent = "// output will appear here...";
  if (statusText) statusText.textContent = "Ready";
}

resetBtn?.addEventListener("click", () => {
  resetFields();
});

runBtn?.addEventListener("click", async () => {
  setBusy(true);
  const a = inputA?.value ?? "";
  const b = inputB?.value ?? "";
  const mode = modeSelect?.value ?? "balanced";
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const payload = { ok: true, timestamp: Date.now(), a, b, mode };
    if (logArea) {
      logArea.textContent = JSON.stringify(payload, null, 2);
    }
    if (statusText) statusText.textContent = "Done";
  } catch (err) {
    if (logArea) {
      logArea.textContent =
        err && err.stack ? err.stack : `Error: ${String(err)}`;
    }
    if (statusText) statusText.textContent = "Error";
  } finally {
    setBusy(false);
  }
});

// Ensure defaults on load
resetFields();
