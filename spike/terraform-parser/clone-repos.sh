#!/usr/bin/env bash
# Spike quality. Clone the six public repositories at the exact commits tested.
set -euo pipefail
dest=${1:?usage: clone-repos.sh <dest-dir>}
mkdir -p "$dest"
while read -r repo sha; do
  name=${repo#*/}
  if [ ! -d "$dest/$name" ]; then
    git init -q "$dest/$name"
    git -C "$dest/$name" remote add origin "https://github.com/$repo"
  fi
  git -C "$dest/$name" fetch -q --depth 1 origin "$sha"
  git -C "$dest/$name" checkout -q --detach FETCH_HEAD
  echo "$repo $(git -C "$dest/$name" rev-parse HEAD)"
done <<'EOF'
hashicorp/learn-terraform-provision-eks-cluster 20816e4bcc757a242ba9be7544401a22b45b055e
terraform-aws-modules/terraform-aws-vpc b3abd6df2ecf052451a361ed55b8f06f8742a795
terraform-aws-modules/terraform-aws-eks 91b8a8d944e3cf169483108acd12d5b1e47856f7
Azure/terraform-azurerm-caf-enterprise-scale 651a585c7fc113315477b957bbd9e8d09e4ff60f
aws-ia/terraform-aws-control_tower_account_factory c5d871757803f73e0ffa144f433e6038b59f366b
GoogleCloudPlatform/cloud-foundation-fabric e6005a63339fff29550260d8ac1384d591c8f865
EOF
