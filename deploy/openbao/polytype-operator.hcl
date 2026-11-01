# Human operator: rotate this key and issue single-use AppRole credentials.
path "secret/data/polytype/admin" {
  capabilities = ["create", "read", "update"]
}

path "secret/metadata/polytype/admin" {
  capabilities = ["read"]
}

path "auth/approle/role/polytype/secret-id" {
  capabilities = ["update", "list"]
}

path "auth/approle/role/polytype/secret-id-accessor/lookup" {
  capabilities = ["update"]
}

path "auth/approle/role/polytype/secret-id-accessor/destroy" {
  capabilities = ["update"]
}

