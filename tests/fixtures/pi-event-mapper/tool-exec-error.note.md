# tool-exec-error

When `isError: true`, the mapper inverts to `ok: false` and surfaces `result` as `error` on the workspace event. Successful runs emit no `error` field at all.
