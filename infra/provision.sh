#!/usr/bin/env bash
# One-time, idempotent provisioning of an Always Free VM on Oracle Cloud (OCI).
# Creates (or reuses) a VCN, internet gateway, public subnet, firewall rules and one VM.
#
# Requirements: OCI CLI configured (~/.oci/config), an SSH public key.
# Usage: SSH_PUBLIC_KEY=~/.ssh/dilemma_oci.pub bash infra/provision.sh
#
# Shapes tried, all Always Free eligible:
#   VM.Standard.A1.Flex (Ampere ARM; 2 OCPU / 12 GB of the free 4 OCPU / 24 GB)
#   VM.Standard.E2.1.Micro (AMD; 1/8 OCPU / 1 GB)
set -euo pipefail

OCI="${OCI:-oci}"
NAME="${NAME:-dilemma}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-$HOME/.ssh/dilemma_oci.pub}"
OCI_CONFIG="${OCI_CONFIG:-$HOME/.oci/config}"
A1_OCPUS="${A1_OCPUS:-2}"
A1_MEM_GB="${A1_MEM_GB:-12}"

# Root compartment = tenancy OCID
COMPARTMENT="${COMPARTMENT:-$(grep -m1 '^tenancy' "$OCI_CONFIG" | cut -d= -f2 | tr -d ' \r')}"
[ -n "$COMPARTMENT" ] || { echo "Could not read tenancy from $OCI_CONFIG" >&2; exit 1; }

log() { echo "==> $*" >&2; }
q() { "$OCI" "$@" --raw-output 2>/dev/null | tr -d '\r'; }
none() { [ -z "$1" ] || [ "$1" = "null" ]; }

log "Checking OCI CLI auth"
"$OCI" iam compartment get -c "$COMPARTMENT" --query 'data.name' --raw-output >/dev/null

# ---------- VCN ----------
VCN=$(q network vcn list -c "$COMPARTMENT" --display-name "$NAME-vcn" --lifecycle-state AVAILABLE --query 'data[0].id')
if none "$VCN"; then
  log "Creating VCN"
  VCN=$(q network vcn create -c "$COMPARTMENT" --display-name "$NAME-vcn" --cidr-blocks '["10.0.0.0/16"]' \
        --dns-label "$NAME" --wait-for-state AVAILABLE --query 'data.id')
fi
log "VCN: $VCN"
RT=$(q network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"')
SL=$(q network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"')

# ---------- Internet gateway + default route ----------
IGW=$(q network internet-gateway list -c "$COMPARTMENT" --vcn-id "$VCN" --lifecycle-state AVAILABLE --query 'data[0].id')
if none "$IGW"; then
  log "Creating internet gateway"
  IGW=$(q network internet-gateway create -c "$COMPARTMENT" --vcn-id "$VCN" --is-enabled true \
        --display-name "$NAME-igw" --wait-for-state AVAILABLE --query 'data.id')
fi
log "Setting default route -> internet gateway"
"$OCI" network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null

# ---------- Security list: SSH, HTTP, HTTPS, ICMP ----------
log "Updating security list (22, 80, 443)"
tcp() { echo "{\"source\":\"0.0.0.0/0\",\"protocol\":\"6\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":$1,\"max\":$1}}}"; }
INGRESS="[$(tcp 22),$(tcp 80),$(tcp 443),{\"source\":\"0.0.0.0/0\",\"protocol\":\"1\",\"icmpOptions\":{\"type\":3,\"code\":4}},{\"source\":\"10.0.0.0/16\",\"protocol\":\"1\",\"icmpOptions\":{\"type\":3}}]"
"$OCI" network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules "$INGRESS" \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' >/dev/null

# ---------- Public subnet ----------
SUBNET=$(q network subnet list -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-subnet" --lifecycle-state AVAILABLE --query 'data[0].id')
if none "$SUBNET"; then
  log "Creating public subnet"
  SUBNET=$(q network subnet create -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-subnet" \
           --cidr-block 10.0.0.0/24 --dns-label pub --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
           --wait-for-state AVAILABLE --query 'data.id')
fi
log "Subnet: $SUBNET"

# ---------- Instance ----------
INSTANCE=$("$OCI" compute instance list -c "$COMPARTMENT" --display-name "$NAME" --raw-output \
  --query "data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'] | [0].id" 2>/dev/null | tr -d '\r')

if none "$INSTANCE"; then
  ADS=$(q iam availability-domain list -c "$COMPARTMENT" --query 'join(`" "`, data[].name)')
  for SHAPE in VM.Standard.A1.Flex VM.Standard.E2.1.Micro; do
    IMAGE=$(q compute image list -c "$COMPARTMENT" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
            --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --query 'data[0].id')
    if none "$IMAGE"; then log "No Ubuntu 24.04 image for $SHAPE, skipping"; continue; fi
    SHAPE_ARGS=()
    [ "$SHAPE" = "VM.Standard.A1.Flex" ] && SHAPE_ARGS=(--shape-config "{\"ocpus\":$A1_OCPUS,\"memoryInGBs\":$A1_MEM_GB}")
    for AD in $ADS; do
      log "Trying $SHAPE in $AD"
      if OUT=$("$OCI" compute instance launch -c "$COMPARTMENT" --availability-domain "$AD" --shape "$SHAPE" "${SHAPE_ARGS[@]}" \
            --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true --display-name "$NAME" \
            --hostname-label "$NAME" --ssh-authorized-keys-file "$SSH_PUBLIC_KEY" \
            --wait-for-state RUNNING --max-wait-seconds 900 --query 'data.id' --raw-output 2>&1); then
        INSTANCE=$(echo "$OUT" | tr -d '\r' | grep -o 'ocid1.instance[^" ]*' | head -1)
        break 2
      else
        echo "$OUT" | grep -iE '"message"|capacity|limit' | head -3 >&2 || true
      fi
    done
  done
fi
none "$INSTANCE" && { echo "Failed to launch an Always Free instance (capacity?). Try again later." >&2; exit 1; }
log "Instance: $INSTANCE"

IP=$(q compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"')
log "Public IP: $IP"
echo "$IP"
