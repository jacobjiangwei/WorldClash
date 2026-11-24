targetScope = 'subscription'

@description('Environment identifier used for resource naming and tags.')
param environmentName string = 'worldclash-dev-39ca'

@description('Azure region for the resource group and App Service resources.')
param location string = 'eastasia'

var resourceGroupName = 'rg-${environmentName}'
var appServicePlanName = 'asp-${environmentName}'
var webAppName = 'app-${environmentName}'

var tags = {
  environment: environmentName
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module appServicePlan 'modules/app-service-plan.bicep' = {
  name: 'appServicePlan'
  scope: resourceGroup
  params: {
    location: location
    planName: appServicePlanName
    tags: tags
  }
}

module webApp 'modules/app-service-web.bicep' = {
  name: 'worldClashWebApp'
  scope: resourceGroup
  params: {
    location: location
    appName: webAppName
    appServicePlanId: appServicePlan.outputs.planId
    tags: tags
  }
}

output webAppName string = webApp.outputs.appName
output webAppUrl string = 'https://${webApp.outputs.defaultHostName}'
