name: Continuous Integration

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      # Étape 1 : Cloner le code source
      - name: Checkout code
        uses: actions/checkout@v3

      # Étape 2 : Configurer Node.js version 20
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 20

      # Étape 3 : Installer les dépendances
      - name: Install dependencies
        run: npm install

      # Étape 4 : Lancer les tests
      - name: Run tests
        run: npm test

      # Étape 5 : Vérification sécurité
      - name: Audit security
        run: npm audit --audit-level=high || true
 
