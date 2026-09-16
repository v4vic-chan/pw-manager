// PreToolUse hook：攔截危險 Bash/命令列指令
const readInput = () => new Promise((resolve) => {
  let data = '';
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});

(async () => {
  const raw = await readInput();
  let command = '';
  try {
    const input = JSON.parse(raw);
    command = input.tool_input && input.tool_input.command ? input.tool_input.command : '';
  } catch (e) {
    process.exit(0);
  }

  const dangerousPatterns = [
    /rm\s+-rf/i,
    /rmdir\s+\/s/i,
    /del\s+\/f\s+\/s\s+\/q/i,
    /sudo\s/i,
    /chmod\s+777/i,
    /--force/i,
    /curl.*\|\s*sh/i,
    /git\s+push.*--force/i,
    /format\s+[a-z]:/i
  ];

  if (dangerousPatterns.some((p) => p.test(command))) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked: 偵測到高風險指令，已攔截，請確認後手動執行。',
      },
    }));
    process.exit(0);
  }
  process.exit(0);
})();
