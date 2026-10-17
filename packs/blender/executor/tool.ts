import { z } from "zod"

// Shared definitions keep defaults/validation identical across both entrypoints.
export function tool<T extends z.ZodRawShape>(definition: {
  description: string
  args: T
  execute: (args: z.infer<z.ZodObject<T>>, context: {
    metadata: (value: { title: string; metadata: unknown }) => void
  }) => Promise<{ title: string; output: string }>
}) {
  return {
    ...definition,
    execute: (args: z.input<z.ZodObject<T>>, context: Parameters<typeof definition.execute>[1]) =>
      definition.execute(z.object(definition.args).parse(args), context),
  }
}
tool.schema = z
