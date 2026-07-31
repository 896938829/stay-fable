import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("demo lifecycle remains owner-scoped and simulator reachable", async () => {
  const [powershell, shell, manifestText] = await Promise.all([
    read("scripts/demo-runtime.ps1"),
    read("scripts/demo-runtime.sh"),
    read("package.json"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(powershell, /ValidateSet\('Up', 'Status', 'Down'\)/);
  assert.match(powershell, /Ubuntu-22\.04/);
  assert.match(powershell, /\.demo-runtime/);
  assert.match(powershell, /prisma:migrate/);
  assert.match(powershell, /prisma:seed/);
  assert.match(shell, /127\.0\.0\.1:3000:3000/);
  assert.match(shell, /127\.0\.0\.1:55432:5432/);
  assert.match(shell, /127\.0\.0\.1:56379:6379/);
  assert.match(shell, /IDENTITY_PROVIDER=mock/);
  assert.match(shell, /ENABLE_MOCK_PAYMENT=true/);
  assert.match(shell, /--user node/);
  assert.match(shell, /--read-only/);
  assert.match(shell, /--cap-drop ALL/);
  assert.match(shell, /no-new-privileges/);
  assert.match(shell, /\/health\/ready/);
  assert.match(shell, /stay-fable\.demo-owner/);
  assert.doesNotMatch(shell, /docker system prune|docker volume prune/);
  assert.equal(
    manifest.scripts["demo:up"],
    "pwsh -NoProfile -File scripts/demo-runtime.ps1 -Action Up",
  );
  assert.equal(
    manifest.scripts["demo:status"],
    "pwsh -NoProfile -File scripts/demo-runtime.ps1 -Action Status",
  );
  assert.equal(
    manifest.scripts["demo:down"],
    "pwsh -NoProfile -File scripts/demo-runtime.ps1 -Action Down",
  );
});
