// 最小 node 类型声明（环境无 @types/node，仅覆盖测试用到的 API）。
declare module 'node:test' {
  type TestFn = (t: unknown) => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  };
  export default assert;
}
