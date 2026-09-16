// 手動重置熔斷計數器，於升級處置完成、確認測試通過後執行
const fs = require('fs');
const path = require('path');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = path.join(projectDir, '.claude', 'state', 'fix-attempts.count');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, '0');
console.log('熔斷計數器已重置為 0。');
