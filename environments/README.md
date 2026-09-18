# Terraform environment roots

`preview/`, `staging/`, and `production/` are independent Terraform roots for **zed-pkg**. They share modules but never Terraform state.

Provider-native source remains canonical under `modules/`:

- Cloudflare Worker/Page source: `modules/cloudflare/<worker-or-site>`
- Neon native IaC: `modules/neon/neon.ts`
- Supabase native project: `modules/supabase/`

The Terraform roots compose account/environment resources; they are not a second copy of provider-native configuration.

This repo also contains `modules/cloudflare/durable-coordinator`. After the Cloudflare account/project root is wired, enable the shell explicitly with `-var=enable_cloudflare_worker=true`. Terraform owns the stable Worker shell; Wrangler owns versions, bindings, and the Durable Object `exports` lifecycle.

## R2 remote state

Supply a unique state key at init time:

```bash
cd environments/preview
terraform init \
  -backend-config=../backend.r2.hcl.example \
  -backend-config="key=zed-pkg/preview/terraform.tfstate"
terraform validate
terraform plan -var="cloudflare_account_id=$CLOUDFLARE_ACCOUNT_ID"
```

Use `zed-pkg/staging/terraform.tfstate` and `zed-pkg/production/terraform.tfstate` for the other roots.

R2 backend credentials come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; Cloudflare provider authentication comes from `CLOUDFLARE_API_TOKEN`. Do not commit credentials.

CI runs `terraform init -backend=false` and `terraform validate`, so pull requests verify the provider/module graph without touching live state.
