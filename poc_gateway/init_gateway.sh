#!/bin/bash
set -e

echo "[*] Generating RSA Keypair for Devolutions Gateway Provisioner"
openssl genrsa -out provisioner.pem 2048
openssl rsa -in provisioner.pem -pubout -out provisioner.pub.pem

echo "[*] Generating Self-Signed TLS Certificate for Devolutions Gateway (Optional but required by config)"
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"

# Create a clean gateway.json
cat > gateway.json << 'EOF'
{
  "Id": "00000000-0000-0000-0000-000000000000",
  "Hostname": "localhost",
  "TlsCertificateFile": "/etc/gateway/cert.pem",
  "TlsPrivateKeyFile": "/etc/gateway/key.pem",
  "ProvisionerPublicKeyFile": "/etc/gateway/provisioner.pub.pem",
  "Listeners": [
    {
      "InternalUrl": "http://*:8080",
      "ExternalUrl": "http://localhost:8080"
    }
  ]
}
EOF

echo "[*] Configuration generated. Ready to boot docker."
