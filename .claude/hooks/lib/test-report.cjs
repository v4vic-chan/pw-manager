// 共用工具：執行 vitest 並解析 JSON 報告，回傳失敗項目清單（供退化判定使用）
const fs = require('fs');
const { execSync } = require('child_process');

function runTestsAndGetFailures(projectDir, reportFile) {
  try {
    execSync(`npx vitest run --reporter=json --outputFile="${reportFile}"`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch (e) {
    // vitest 有測試失敗時會以非 0 結束碼結束，但 JSON 報告仍會寫出，
    // 因此這裡吞掉 exec 的錯誤，實際成功與否以下方能否讀到報告檔為準。
  }

  const raw = fs.readFileSync(reportFile, 'utf8');
  const report = JSON.parse(raw);
  const failures = [];

  for (const suite of report.testResults || []) {
    if (!suite.assertionResults || suite.assertionResults.length === 0) {
      if (suite.status === 'failed') {
        const reason = suite.message ? suite.message.split('\n')[0] : '';
        failures.push({
          id: `${suite.name}::__suite__`,
          label: `[套件載入失敗] ${suite.name}${reason ? '：' + reason : ''}`,
        });
      }
      continue;
    }
    for (const assertion of suite.assertionResults) {
      if (assertion.status === 'failed') {
        failures.push({
          id: `${suite.name}::${assertion.fullName}`,
          label: `${suite.name} > ${assertion.fullName}`,
        });
      }
    }
  }

  return failures;
}

module.exports = { runTestsAndGetFailures };
