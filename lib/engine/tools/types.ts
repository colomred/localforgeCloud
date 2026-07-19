/**
 * Engine tool contract. Deliberately tiny: a name, a one-line description,
 * a SHORT flat JSON schema, and an executor. Small local models get exactly
 * five of these — schema brevity is a feature, not an omission.
 */

export type ToolExecutionContext = {
  /** Absolute path of the project workspace; all paths resolve against it. */
  projectDir: string;
};

export type EngineTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Run the tool. Returns the text shown to the model. Throwing is fine —
   * the loop converts errors into tool-result text so the model can react.
   */
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string>;
};

export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function intArg(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}
