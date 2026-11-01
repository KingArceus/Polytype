# Single-host deployment: keep the API and cluster listeners on loopback.
ui           = false
api_addr     = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"

storage "raft" {
  path    = "/var/lib/openbao/raft"
  node_id = "polytype-1"
}

listener "tcp" {
  address         = "127.0.0.1:8200"
  cluster_address = "127.0.0.1:8201"
  tls_cert_file   = "/etc/openbao/tls/server.crt"
  tls_key_file    = "/etc/openbao/tls/server.key"
  tls_min_version = "tls12"
}

# Declare audit devices in config; API creation is disabled by default.
audit "file" "polytype-file" {
  description = "Polytype OpenBao audit log"
  options {
    file_path = "/var/log/openbao/audit.json"
  }
}
