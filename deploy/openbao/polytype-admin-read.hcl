# KV v2 uses /data/ in policy/API paths, unlike the `bao kv` CLI path.
path "secret/data/polytype/admin" {
  capabilities = ["read"]
}
