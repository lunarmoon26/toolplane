import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020"
import { Fault } from "./contracts"

const options = { strict: false, validateFormats: false, ownProperties: true, addUsedSchema: false }
const draft07 = new Ajv(options)
const draft2020 = new Ajv2020(options)

// Preserve and honor the advertised dialect. Never silently downgrade or fetch refs.
export function compileInputSchema(schema: Record<string, unknown>) {
  const dialect = schema.$schema
  const validator = dialect === undefined || dialect === "http://json-schema.org/draft-07/schema#" || dialect === "http://json-schema.org/draft-07/schema"
    ? draft07
    : dialect === "https://json-schema.org/draft/2020-12/schema" || dialect === "https://json-schema.org/draft/2020-12/schema#"
      ? draft2020 : undefined
  if (!validator) throw new Fault("unsupported_schema", "Input schema must use draft-07 or JSON Schema 2020-12", 422)
  try { return validator.compile(schema) }
  catch { throw new Fault("unsupported_schema", "Input schema is invalid or contains unsupported references for its declared dialect", 422) }
}
