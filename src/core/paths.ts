export const trimSlashes = (path: string) => path.replace(/\/+$/, '')

export const trimPath = (path: string) => trimSlashes(path) || '/'

export const workOf = (config: { workDir: string }) => trimSlashes(config.workDir)
