// 手動重置熔斷計數器，並依目前測試結果重建基準失敗清單，
// 於升級處置完成、或確認新的紅燈是刻意的進度推進後執行。
const fs = require('fs');
const path = require('path');
const { runTestsAndGetFailures } = require('./lib/test-report.cjs');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, '.claude', 'state');
const stateFile = path.join(stateDir, 'fix-attempts.count');
const baselineFile = path.join(stateDir, 'baseline-failures.json');
const reportFile = path.join(stateDir, 'test-report.json');

fs.mkdirSync(stateDir, { recursive: true });

let failures;
try {
  failures = runTestsAndGetFailures(projectDir, reportFile);
} catch (err) {
  fs.writeFileSync(stateFile, '0');
  console.log(`熔斷計數器已重置為 0。（警告：測試報告產生或解析失敗，基準清單未更新：${err.message}）`);
  process.exit(0);
}

fs.writeFileSync(
  baselineFile,
  JSON.stringify({ updatedAt: new Date().toISOString(), failureIds: failures.map((f) => f.id) }, null, 2)
);
fs.writeFileSync(stateFile, '0');
console.log(`熔斷計數器已重置為 0，基準失敗清單已依目前測試結果更新（共 ${failures.length} 項既有失敗）。`);
