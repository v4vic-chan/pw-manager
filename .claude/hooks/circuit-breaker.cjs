// PreToolUse hook：連續修補失敗達門檻（2 次）後，攔截後續 Write/Edit，強制中斷
const fs = require('fs');
const path = require('path');

const THRESHOLD = 2;
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = path.join(projectDir, '.claude', 'state', 'fix-attempts.count');

if (fs.existsSync(stateFile)) {
  const count = parseInt(fs.readFileSync(stateFile, 'utf8').trim() || '0', 10);
  if (count >= THRESHOLD) {
    process.stderr.write(
      `熔斷觸發：同一任務已連續 ${count} 次修補未通過測試，已強制中斷。` +
      `請人工介入，或指示升級至更強模型（Opus/Fable）處理此模組後，` +
      `執行 node .claude/hooks/reset-counter.cjs 重置計數。\n`
    );
    process.exit(2);
  }
}
process.exit(0);
