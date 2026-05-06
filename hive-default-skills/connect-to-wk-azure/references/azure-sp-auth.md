# Azure Service Principal Authentication Reference

## Authentication Methods

### Service Principal with Client Secret
The primary method used by this skill. Uses `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, and `ARM_TENANT_ID`.

```bash
az login --service-principal -u "$ARM_CLIENT_ID" -p "$ARM_CLIENT_SECRET" --tenant "$ARM_TENANT_ID"
```

### Token Lifetime
- Access tokens: ~1 hour (auto-refreshed by az CLI)
- Client secrets: configurable expiry (check Azure portal > App registrations > Certificates & secrets)

## Subscription Management

```bash
# List all accessible subscriptions
az account list --query '[].{Name:name, Id:id, State:state}' --output table

# Set active subscription
az account set --subscription "<SUBSCRIPTION_ID>"

# Show current subscription
az account show --output table
```

## Common Azure Resource Commands

### Compute
```bash
az vm list --output table
az vm get-instance-view --name <VM> --resource-group <RG> --query 'instanceView.statuses[1]' --output table
az vm start --name <VM> --resource-group <RG>
az vm stop --name <VM> --resource-group <RG>
az vmss list --output table
```

### Networking
```bash
az network vnet list --output table
az network nsg list --output table
az network public-ip list --output table
az network lb list --output table
```

### Storage
```bash
az storage account list --output table
az storage container list --account-name <ACCOUNT> --output table
```

### Kubernetes
```bash
az aks list --output table
az aks get-credentials --name <CLUSTER> --resource-group <RG>
```

### Resource Groups
```bash
az group list --output table
az resource list --resource-group <RG_NAME> --output table
```

## Error Codes

| AADSTS Code | Meaning |
|-------------|---------|
| `AADSTS7000215` | Client secret is expired or invalid |
| `AADSTS700016` | Application (client ID) not found in tenant |
| `AADSTS70001` | Application is disabled in tenant |
| `AADSTS50034` | User account doesn't exist in tenant |
| `AADSTS65001` | App doesn't have consent/permissions |

## Terraform Integration

The `azurerm` provider reads these env vars automatically:
- `ARM_CLIENT_ID`
- `ARM_CLIENT_SECRET`
- `ARM_TENANT_ID`
- `ARM_SUBSCRIPTION_ID`

No provider block credentials needed when these are exported.
