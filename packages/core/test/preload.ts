import path from "path"

process.env.EXA_DB = ":memory:"
process.env.EXA_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.EXA_DISABLE_MODELS_FETCH = "true"
