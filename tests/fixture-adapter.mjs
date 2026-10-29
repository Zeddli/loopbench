// Deterministic process fixture for integration tests, never registered in the application catalog.
let source = "";
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
if (request.config.settings.mode === "invalid") { process.stdout.write("invalid json"); process.exit(0); }
if (request.config.settings.mode === "crash") { process.stderr.write("fixture process failure"); process.exit(2); }
const functions = {
  "unique-stable": "module.exports = values => [...new Set(values)];",
  "chunk-array": "module.exports = (values, size) => { if(size <= 0)return []; const out=[]; for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size)); return out; };",
  "balanced-brackets": "module.exports = text => { const stack=[]; const pairs={')':'(',']':'[','}':'{'}; for(const c of text){if('([{'.includes(c))stack.push(c); else if(c in pairs && stack.pop()!==pairs[c])return false;}return stack.length===0; };",
};
const output = request.config.settings.mode === "correct" ? functions[request.task.id] : "module.exports = () => null;";
process.stdout.write(JSON.stringify({ output, inputTokens: 7, outputTokens: 9, costUsd: 0 }));
