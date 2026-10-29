import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  const code = request.output
    .trim()
    .replace(/^```(?:javascript|js)?\s*\n/, "")
    .replace(/\n```\s*$/, "");
  const context = vm.createContext(
    {},
    { codeGeneration: { strings: false, wasm: false } },
  );
  new vm.Script(
    "var module = { exports: {} }; var exports = module.exports;\n" + code,
  ).runInContext(context, { timeout: 1000 });
  if (typeof context.module.exports !== "function")
    throw new Error(
      "Export one function with module.exports = function (...args) { ... }",
    );
  for (let index = 0; index < request.cases.length; index++) {
    const test = request.cases[index];
    const description = test.label
      ? `Case: ${test.label}`
      : `Hidden check ${index + 1}`;
    try {
      new vm.Script(
        `var testArgs = JSON.parse(${JSON.stringify(JSON.stringify(test.args))}); var originalArgs = JSON.stringify(testArgs);`,
      ).runInContext(context, { timeout: 1000 });
      // JSON crosses realms so prototypes do not affect value comparison.
      const actual = new vm.Script(
        `var actual = JSON.stringify(module.exports(...testArgs)); if (${request.nonMutating === true} && JSON.stringify(testArgs) !== originalArgs) throw new Error("Function mutated input"); actual;`,
      ).runInContext(context, { timeout: 1000 });
      if (
        actual === undefined ||
        !isDeepStrictEqual(JSON.parse(actual), test.expected)
      )
        throw new Error("result mismatch");
    } catch (error) {
      throw new Error(
        `${description}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  process.stdout.write(JSON.stringify({ passed: true, error: null }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
