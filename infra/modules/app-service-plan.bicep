targetScope = 'resourceGroup'

param location string
param planName string
param tags object

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: 'F1'
    tier: 'Free'
    size: 'F1'
    family: 'F'
    capacity: 1
  }
  properties: {
    reserved: true
  }
  tags: tags
}

output planId string = plan.id
