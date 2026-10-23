# Bill.com MCP Server

A Model Context Protocol (MCP) server for integrating Bill.com accounting and payment services with AI assistants like Claude.

## API Access Types

This server supports **three authentication modes** for the Bill.com AP/AR API:

| Auth Type | Access Level | Session Duration | Use Case |
|-----------|-------------|------------------|----------|
| `sync_token` | Limited (read/sync) | 48 hours | ERP syncing, reporting, read-only integrations |
| `full_access` | Full (read/write) | 35 minutes | Complete AP/AR operations including payments |
| `session_token` | Depends on token | External | When auth is handled by an external system |

**Documentation**:
- [AP/AR Sync Token Sign In](https://developer.bill.com/docs/token-based-sign-in)
- [Bill.com Keys and Tokens](https://developer.bill.com/docs/bill-keys-tokens)

## Features (89 Tools)

### Accounts Payable (AP)
- **Vendor Management**: List, get, create, update, archive, restore vendors
- **Vendor Bank Accounts**: List, create, delete (Full Access only)
- **Bill Operations**: List, get, create, update, archive, restore bills
- **Recurring Bills**: Full CRUD operations
- **Payment Management**: List, get, create, cancel, void payments
- **Vendor Credits**: List, get, create, update, archive
- **Bill Approvals**: Manage policies, approve/deny bills (Full Access only)

### Accounts Receivable (AR)
- **Customer Management**: List, get, create, update, archive, restore customers
- **Customer Bank Accounts**: List, create, delete (Full Access only)
- **Charge Authorization**: Enable/disable customer charging (Full Access only)
- **Invoice Management**: List, get, create, update, archive, restore, send invoices
- **Recurring Invoices**: List, get, create, update
- **Credit Memos**: List, get, create, update, archive, restore
- **Receivable Payments**: List, get, charge customers (Full Access only)

### General Ledger (GL)
- **Chart of Accounts**: List, get, create, update, archive, restore
- **Classifications**: List departments, locations, jobs, employees, items, accounting classes

### Organization
- **Bank Accounts**: List and view organization bank accounts
- **User Management**: List, get, create, update, delete users (Full Access only)

### Session Management
- Automatic login and session refresh
- 48-hour sessions for sync tokens, 35-minute sessions for full access

## Prerequisites

- Node.js 18 or higher
- Bill.com developer account with API access
- Bill.com AP/AR Sync Token and Developer Key from [app-sandbox.bill.com](https://app-sandbox.bill.com)

## Installation

```bash
# Clone the repository
cd bill-mcp-server

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Add your Bill.com credentials to .env
```

## Configuration

Create a `.env` file with your Bill.com AP/AR API credentials:

```env
# Required: Developer Key from Settings → Sync & Integrations → Manage Developer Keys
BILL_DEV_KEY=your_developer_key_here

# Environment: "sandbox" or "production"
# (default: production for stdio; required for http transport)
BILL_ENVIRONMENT=production

# Optional: expose only read-only tools (list_* and get_*)
# (default: true for http transport, false for stdio)
BILL_READ_ONLY=true

# Optional: comma-separated list of tool names to expose
# BILL_ALLOWED_TOOLS=list_bills,get_bill,list_vendors

# Optional: Auth type (default: sync_token)
# - sync_token: Limited access, 48-hour sessions (for syncing/reporting)
# - full_access: Full access, 35-minute sessions (for all operations)
# - session_token: Use pre-authenticated token from external system
BILL_AUTH_TYPE=sync_token

# --- For sync_token and full_access auth ---
BILL_ORGANIZATION_ID=008xxxxxxxxxxxxx
BILL_USERNAME=your_username_here
BILL_PASSWORD=your_password_here

# --- For session_token auth (external auth handling) ---
# BILL_SESSION_TOKEN=your_pre_authenticated_session_token
```

> **Note**: No auth type selector is needed in most integrations because both `sync_token` and `full_access` use the same credential structure (devKey, username, password, organizationId). The API accepts both credential types with the same request format. The difference is only in the session duration and available operations.

### Auth Type Comparison

| Feature | Sync Token | Full Access | Session Token |
|---------|------------|-------------|---------------|
| Read vendors, bills, invoices, customers | ✅ | ✅ | Depends on token |
| Create/update vendors, bills, invoices | ✅ | ✅ | Depends on token |
| Pay bills, void payments | ❌ | ✅ | Depends on token |
| Send invoices | ❌ | ✅ | Depends on token |
| Charge customers | ❌ | ✅ | Depends on token |
| Manage users | ❌ | ✅ | Depends on token |
| Manage bank accounts | ❌ | ✅ | Depends on token |
| Approve/deny bills | ❌ | ✅ | Depends on token |
| Session management | Auto-refresh | Auto-refresh | External |
| Session duration | 48 hours | 35 minutes | External |

### Getting Bill.com AP/AR API Credentials

#### Step 1: Get Developer Key
1. Sign in to your Bill.com account
2. Navigate to **Settings** → **Sync & Integrations** → **Manage Developer Keys**
3. Click **Add Developer Key** to generate a new key (you can have up to 4)
4. Copy the generated **Developer Key**
   - Use this as `BILL_DEV_KEY` in your configuration

#### Step 2: Create AP/AR Sync Token
1. From the same **Sync & Integrations** page, go to the **Tokens** section
2. Click **Create AP/AR Sync Token**
3. Enter a descriptive name for your token (e.g., `mcp-server-token`)
   - Use this name as `BILL_USERNAME` in your configuration
4. Click **Create** and copy the generated token value
   - Use this value as `BILL_PASSWORD` in your configuration
   - **Important**: Save this token immediately as it won't be shown again

#### Step 3: Find Organization ID
Your Organization ID is displayed on the **Sync & Integrations** page and starts with `008`
- Use this as `BILL_ORGANIZATION_ID` in your configuration

#### Summary of Credentials Mapping
| Bill.com Portal | Environment Variable | Example |
|----------------|---------------------|---------|
| Developer Key | `BILL_DEV_KEY` | `01XXX...` |
| Sync Token Name | `BILL_USERNAME` | `mcp-server-token` |
| Sync Token Value | `BILL_PASSWORD` | `02XXX-XXXXX-...` |
| Organization ID | `BILL_ORGANIZATION_ID` | `008xxxxxxxxxxxxx` |

**Reference**: [Bill.com AP/AR Token-Based Sign In Documentation](https://developer.bill.com/docs/token-based-sign-in)

## Usage

### Development

```bash
# Run in development mode with auto-reload
npm run dev
```

### Production

```bash
# Build the TypeScript code
npm run build

# Run the compiled server
npm start
```

### Docker

The image runs the HTTP transport (see [Remote Deployment](#remote-deployment-http)).

```bash
# Build the Docker image
docker build -t bill-mcp-server .

# Run the container
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e MCP_AUTH_TOKEN=your_random_token_of_at_least_32_chars \
  -e BILL_DEV_KEY=your_dev_key \
  -e BILL_USERNAME=your_sync_token_name \
  -e BILL_PASSWORD=your_sync_token_value \
  -e BILL_ORGANIZATION_ID=008xxxxxxxxxxxxx \
  -e BILL_ENVIRONMENT=sandbox \
  bill-mcp-server
```

## Remote Deployment (HTTP)

By default the server speaks MCP over stdio, for clients that launch it locally. Set
`MCP_TRANSPORT=http` (or just `PORT`, which hosting platforms set for you) to serve the
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
transport instead:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /mcp` | Bearer token (OAuth access token or `MCP_AUTH_TOKEN`) | MCP requests (stateless) |
| `/authorize`, `/token`, `/register`, `/.well-known/*` | None | OAuth endpoints (Google sign-in only) |
| `GET /health` | None | Health check, returns `{"status":"ok"}` |

In HTTP mode:

- `BILL_ENVIRONMENT` must be set explicitly, so a deployment never defaults to production.
- `BILL_READ_ONLY` defaults to `true`. Set it to `false` only if the AI should be able to
  create or change data in Bill.com, and combine it with `BILL_ALLOWED_TOOLS` to expose only
  the write tools you need.
- Every `/mcp` request must be authenticated, with Google sign-in or a static token.

### Authentication: Google sign-in (recommended)

Each user signs in with their own Google account, and only the emails in
`BILL_ALLOWED_EMAILS` get access. This is what Claude.ai connectors expect: the server acts
as an OAuth 2.1 authorization server (with dynamic client registration and PKCE) and
delegates the sign-in itself to Google.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → OAuth consent screen**: configure it. For a Google Workspace
   organization, choose **Internal** so only accounts from your domain can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://<your-domain>/oauth/google/callback`
4. Set these variables:

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | Client ID from step 3 |
| `GOOGLE_CLIENT_SECRET` | Client secret from step 3 |
| `BILL_ALLOWED_EMAILS` | Comma-separated emails, e.g. `alice@example.com,bob@example.com` |
| `OAUTH_SIGNING_SECRET` | Random secret, at least 32 characters (`openssl rand -hex 32`) |
| `PUBLIC_URL` | `https://<your-domain>` (optional on Railway: defaults to `https://$RAILWAY_PUBLIC_DOMAIN`) |

Tokens are signed by the server and need no database, so they survive restarts. Access
tokens last 1 hour and refresh tokens 30 days, and every request is checked against the
current `BILL_ALLOWED_EMAILS`: removing an email revokes that user at once. Changing
`OAUTH_SIGNING_SECRET` signs everyone out.

`MCP_AUTH_TOKEN` stays optional in this mode. If set, it is accepted **without** sign-in and
bypasses the email list, so remove it unless a client needs it.

### Authentication: static token

Without `GOOGLE_CLIENT_ID`, every request must send `Authorization: Bearer $MCP_AUTH_TOKEN`.
The token must be at least 32 characters. Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Railway

The repository root holds a `railway.json` and a `Dockerfile` that build this server, so no
build settings are needed:

1. Create a service from this GitHub repository and pick the branch to deploy. Railway
   redeploys on every push to that branch.
2. In the service **Settings**, leave **Root Directory** empty (the repository root).
3. In **Variables**, set `BILL_ENVIRONMENT`, `BILL_DEV_KEY`, `BILL_ORGANIZATION_ID`,
   `BILL_AUTH_TYPE=sync_token`, `BILL_USERNAME` and `BILL_PASSWORD`, plus the variables for
   [Google sign-in](#authentication-google-sign-in-recommended) or `MCP_AUTH_TOKEN`.
   Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN`.
4. In **Networking**, generate a public domain. The MCP endpoint is
   `https://<your-domain>/mcp`.

`railway.json` builds with the root `Dockerfile`, runs a single replica (the Bill.com session
is kept in memory) and uses `/health` as the health check.

### Connecting a client

With Google sign-in, add `https://<your-domain>/mcp` as a custom connector in Claude.ai
(no token needed). Each user is sent to Google to sign in when they connect. Claude Code
works the same way:

```bash
claude mcp add --transport http bill https://<your-domain>/mcp
# then run /mcp in Claude Code to sign in
```

With a static token:

```bash
claude mcp add --transport http bill https://<your-domain>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## Available Tools

### `list_vendors`

List all vendors in the account with optional filtering.

**Parameters**:
- `limit` (number, optional): Maximum number of vendors to return (default: 50, max: 100)
- `offset` (number, optional): Number of vendors to skip for pagination (default: 0)
- `name` (string, optional): Filter by vendor name
- `isActive` (boolean, optional): Filter by active status

**Example**:
```json
{
  "name": "list_vendors",
  "arguments": {
    "limit": 20,
    "isActive": true
  }
}
```

### `get_vendor`

Get detailed information about a specific vendor by ID.

**Parameters**:
- `id` (string, required): The vendor ID

**Example**:
```json
{
  "name": "get_vendor",
  "arguments": {
    "id": "vendor-123"
  }
}
```

### `create_vendor`

Create a new vendor in Bill.com.

**Parameters**:
- `name` (string, required): Vendor name
- `email` (string, optional): Vendor email address
- `phone` (string, optional): Vendor phone number
- `address` (object, optional): Vendor address with line1, line2, city, state, zip, country
- `accountNumber` (string, optional): Account number for this vendor
- `taxId` (string, optional): Tax ID or EIN
- `isActive` (boolean, optional): Whether the vendor is active (default: true)

**Example**:
```json
{
  "name": "create_vendor",
  "arguments": {
    "name": "Acme Supplies Inc",
    "email": "billing@acmesupplies.com",
    "phone": "+1-555-0200",
    "address": {
      "line1": "456 Vendor Ave",
      "city": "Los Angeles",
      "state": "CA",
      "zip": "90001",
      "country": "US"
    },
    "accountNumber": "ACME-001",
    "taxId": "98-7654321"
  }
}
```

### `update_vendor`

Update an existing vendor in Bill.com.

**Parameters**:
- `id` (string, required): The vendor ID to update
- `name` (string, optional): Vendor name
- `email` (string, optional): Vendor email address
- `phone` (string, optional): Vendor phone number
- `address` (object, optional): Vendor address with line1, line2, city, state, zip, country
- `accountNumber` (string, optional): Account number for this vendor
- `taxId` (string, optional): Tax ID or EIN
- `isActive` (boolean, optional): Whether the vendor is active

**Example**:
```json
{
  "name": "update_vendor",
  "arguments": {
    "id": "vendor-123",
    "email": "newemail@acmesupplies.com",
    "isActive": false
  }
}
```

### `list_bills`

List bills (accounts payable) with filtering options.

**Parameters**:
- `limit` (number, optional): Maximum number of bills to return (default: 50, max: 100)
- `offset` (number, optional): Number of bills to skip for pagination (default: 0)
- `status` (string, optional): Filter by status (`draft`, `open`, `scheduled`, `paid`, `void`)
- `vendorId` (string, optional): Filter by vendor ID
- `startDate` (string, optional): Filter by creation date (YYYY-MM-DD)
- `endDate` (string, optional): Filter by creation date (YYYY-MM-DD)

**Example**:
```json
{
  "name": "list_bills",
  "arguments": {
    "status": "open",
    "limit": 10
  }
}
```

### `get_bill`

Get detailed information about a specific bill by ID.

**Parameters**:
- `id` (string, required): The bill ID

**Example**:
```json
{
  "name": "get_bill",
  "arguments": {
    "id": "bill-123"
  }
}
```

### `create_bill`

Create a new bill for a vendor.

**Parameters**:
- `vendorId` (string, required): The vendor ID
- `invoiceNumber` (string, optional): Vendor's invoice number
- `invoiceDate` (string, required): Invoice date (YYYY-MM-DD format)
- `dueDate` (string, required): Payment due date (YYYY-MM-DD format)
- `lineItems` (array, required): Bill line items with description, quantity, unitPrice, amount, chartOfAccountId
- `description` (string, optional): Bill description or memo

**Example**:
```json
{
  "name": "create_bill",
  "arguments": {
    "vendorId": "vendor-123",
    "invoiceNumber": "INV-2025-456",
    "invoiceDate": "2025-11-15",
    "dueDate": "2025-12-15",
    "description": "Monthly office supplies",
    "lineItems": [
      {
        "description": "Paper supplies",
        "quantity": 10,
        "unitPrice": 25.00,
        "amount": 250.00
      },
      {
        "description": "Printer ink",
        "amount": 75.00
      }
    ]
  }
}
```

### `update_bill`

Update an existing bill.

**Parameters**:
- `id` (string, required): The bill ID to update
- `invoiceNumber` (string, optional): Vendor's invoice number
- `invoiceDate` (string, optional): Invoice date (YYYY-MM-DD format)
- `dueDate` (string, optional): Payment due date (YYYY-MM-DD format)
- `lineItems` (array, optional): Bill line items
- `description` (string, optional): Bill description or memo

**Example**:
```json
{
  "name": "update_bill",
  "arguments": {
    "id": "bill-123",
    "dueDate": "2025-12-31",
    "description": "Updated payment terms"
  }
}
```

### `list_payments`

List all payments with optional filtering.

**Parameters**:
- `limit` (number, optional): Maximum number of payments to return (default: 50, max: 100)
- `offset` (number, optional): Number of payments to skip for pagination (default: 0)
- `status` (string, optional): Filter by status (`scheduled`, `processing`, `completed`, `cancelled`, `failed`)
- `vendorId` (string, optional): Filter by vendor ID
- `startDate` (string, optional): Filter by creation date (YYYY-MM-DD)
- `endDate` (string, optional): Filter by creation date (YYYY-MM-DD)

**Example**:
```json
{
  "name": "list_payments",
  "arguments": {
    "status": "completed",
    "limit": 10
  }
}
```

### `get_payment`

Get detailed information about a specific payment by ID.

**Parameters**:
- `id` (string, required): The payment ID

**Example**:
```json
{
  "name": "get_payment",
  "arguments": {
    "id": "payment-123"
  }
}
```

### `create_payment`

Create a new payment for a vendor.

**Parameters**:
- `vendorId` (string, required): The vendor ID to pay
- `amount` (number, required): Payment amount
- `processDate` (string, required): Date to process the payment (YYYY-MM-DD)
- `description` (string, optional): Payment description or memo
- `billIds` (array, optional): Array of bill IDs to pay

**Example**:
```json
{
  "name": "create_payment",
  "arguments": {
    "vendorId": "vendor-123",
    "amount": 1500.00,
    "processDate": "2025-11-25",
    "description": "Payment for November services",
    "billIds": ["bill-456", "bill-789"]
  }
}
```

### `cancel_payment`

Cancel a scheduled payment.

**Parameters**:
- `id` (string, required): The payment ID to cancel

**Example**:
```json
{
  "name": "cancel_payment",
  "arguments": {
    "id": "payment-123"
  }
}
```

### `list_customers`

List all customers with optional filtering.

**Parameters**:
- `limit` (number, optional): Maximum number of customers to return (default: 50, max: 100)
- `offset` (number, optional): Number of customers to skip for pagination (default: 0)
- `name` (string, optional): Filter by customer name
- `isActive` (boolean, optional): Filter by active status

**Example**:
```json
{
  "name": "list_customers",
  "arguments": {
    "limit": 20,
    "isActive": true
  }
}
```

### `get_customer`

Get detailed information about a specific customer by ID.

**Parameters**:
- `id` (string, required): The customer ID

**Example**:
```json
{
  "name": "get_customer",
  "arguments": {
    "id": "customer-123"
  }
}
```

### `create_customer`

Create a new customer in Bill.com.

**Parameters**:
- `name` (string, required): Customer name
- `email` (string, optional): Customer email address
- `phone` (string, optional): Customer phone number
- `address` (object, optional): Customer address with line1, line2, city, state, zip, country
- `taxId` (string, optional): Tax ID or EIN
- `isActive` (boolean, optional): Whether the customer is active (default: true)

**Example**:
```json
{
  "name": "create_customer",
  "arguments": {
    "name": "Acme Corporation",
    "email": "billing@acme.com",
    "phone": "+1-555-0100",
    "address": {
      "line1": "123 Main St",
      "city": "San Francisco",
      "state": "CA",
      "zip": "94105",
      "country": "US"
    },
    "taxId": "12-3456789"
  }
}
```

### `list_invoices`

List all invoices with optional filtering.

**Parameters**:
- `limit` (number, optional): Maximum number of invoices to return (default: 50, max: 100)
- `offset` (number, optional): Number of invoices to skip for pagination (default: 0)
- `status` (string, optional): Filter by status (`draft`, `sent`, `viewed`, `partiallyPaid`, `paid`, `void`)
- `customerId` (string, optional): Filter by customer ID
- `startDate` (string, optional): Filter by creation date (YYYY-MM-DD)
- `endDate` (string, optional): Filter by creation date (YYYY-MM-DD)

**Example**:
```json
{
  "name": "list_invoices",
  "arguments": {
    "status": "sent",
    "limit": 10
  }
}
```

### `get_invoice`

Get detailed information about a specific invoice by ID.

**Parameters**:
- `id` (string, required): The invoice ID

**Example**:
```json
{
  "name": "get_invoice",
  "arguments": {
    "id": "invoice-123"
  }
}
```

### `create_invoice`

Create a new invoice for a customer.

**Parameters**:
- `customerId` (string, required): The customer ID
- `invoiceDate` (string, required): Invoice date (YYYY-MM-DD)
- `dueDate` (string, required): Payment due date (YYYY-MM-DD)
- `lineItems` (array, required): Invoice line items with description, quantity, unitPrice, amount
- `invoiceNumber` (string, optional): Invoice number
- `description` (string, optional): Invoice description or memo

**Example**:
```json
{
  "name": "create_invoice",
  "arguments": {
    "customerId": "customer-123",
    "invoiceNumber": "INV-2025-001",
    "invoiceDate": "2025-11-18",
    "dueDate": "2025-12-18",
    "description": "November consulting services",
    "lineItems": [
      {
        "description": "Consulting hours",
        "quantity": 40,
        "unitPrice": 150.00,
        "amount": 6000.00
      },
      {
        "description": "Project management",
        "amount": 1000.00
      }
    ]
  }
}
```

### `send_invoice`

Send an invoice to the customer via email.

**Parameters**:
- `id` (string, required): The invoice ID to send
- `emailMessage` (string, optional): Custom email message

**Example**:
```json
{
  "name": "send_invoice",
  "arguments": {
    "id": "invoice-123",
    "emailMessage": "Thank you for your business! Payment is due within 30 days."
  }
}
```

### `list_bank_accounts`

List all bank accounts in the Bill.com account.

**Parameters**:
- `limit` (number, optional): Maximum number of bank accounts to return (default: 50, max: 100)
- `offset` (number, optional): Number of bank accounts to skip for pagination (default: 0)
- `isActive` (boolean, optional): Filter by active status

**Example**:
```json
{
  "name": "list_bank_accounts",
  "arguments": {
    "limit": 20,
    "isActive": true
  }
}
```

### `get_bank_account`

Get detailed information about a specific bank account by ID.

**Parameters**:
- `id` (string, required): The bank account ID

**Example**:
```json
{
  "name": "get_bank_account",
  "arguments": {
    "id": "bank-account-123"
  }
}
```

## Roadmap

All high and medium priority features have been implemented! The server now includes:

- ✅ **Vendor Management**: List, view, create, and update vendors
- ✅ **Bill Management**: List, view, create, and update bills
- ✅ **Payment Management**: List, view, create, and cancel payments
- ✅ **Customer Management**: List, view, and create customers
- ✅ **Invoice Management**: List, view, create, and send invoices
- ✅ **Bank Account Management**: List and view bank accounts

### Future Enhancements (Optional)

- Update customer details
- Update invoice details
- Approve/reject payments
- Recurring bill management
- Chart of accounts management
- Enhanced reporting and analytics

## Integration with Claude Desktop

Add this server to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### With Sync Token (limited access)
```json
{
  "mcpServers": {
    "bill-com-ap-ar": {
      "command": "node",
      "args": ["/path/to/bill-mcp-server/ap-ar/dist/index.js"],
      "env": {
        "BILL_DEV_KEY": "your_dev_key",
        "BILL_USERNAME": "your_sync_token_name",
        "BILL_PASSWORD": "your_sync_token_value",
        "BILL_ORGANIZATION_ID": "008xxxxxxxxxxxxx",
        "BILL_ENVIRONMENT": "production",
        "BILL_AUTH_TYPE": "sync_token"
      }
    }
  }
}
```

### With Full Access (all operations)
```json
{
  "mcpServers": {
    "bill-com-ap-ar": {
      "command": "node",
      "args": ["/path/to/bill-mcp-server/ap-ar/dist/index.js"],
      "env": {
        "BILL_DEV_KEY": "your_dev_key",
        "BILL_USERNAME": "user@company.com",
        "BILL_PASSWORD": "your_user_password",
        "BILL_ORGANIZATION_ID": "008xxxxxxxxxxxxx",
        "BILL_ENVIRONMENT": "production",
        "BILL_AUTH_TYPE": "full_access"
      }
    }
  }
}
```

### With Session Token (external auth)
```json
{
  "mcpServers": {
    "bill-com-ap-ar": {
      "command": "node",
      "args": ["/path/to/bill-mcp-server/ap-ar/dist/index.js"],
      "env": {
        "BILL_DEV_KEY": "your_dev_key",
        "BILL_SESSION_TOKEN": "your_pre_authenticated_session_token",
        "BILL_ENVIRONMENT": "production",
        "BILL_AUTH_TYPE": "session_token"
      }
    }
  }
}
```

## Development

### Project Structure

```
bill-mcp-server/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── billcom-client.ts     # Bill.com API client
│   └── tools/
│       ├── index.ts          # Tool registry
│       ├── account.ts        # Account-related tools
│       ├── vendors.ts        # Vendor management tools
│       └── bills.ts          # Bill management tools
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

### Adding New Tools

1. Create a new file in `src/tools/` (e.g., `invoices.ts`)
2. Define your tool following the `Tool` interface
3. Export the tool and add it to `src/tools/index.ts`

Example:

```typescript
// src/tools/invoices.ts
import { Tool } from "./index.js";
import { BillComClient } from "../billcom-client.js";

export const listInvoices: Tool = {
  name: "list_invoices",
  description: "List all invoices (accounts receivable)",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["draft", "sent", "paid"],
      },
    },
  },
  handler: async (args, client) => {
    const invoices = await client.get("/invoices", args);
    return { success: true, data: invoices };
  },
};
```

### Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Run in development mode with tsx
- `npm run watch` - Watch for changes and recompile
- `npm start` - Run the compiled server
- `npm run lint` - Lint the code with ESLint
- `npm run format` - Format code with Prettier
- `npm run typecheck` - Type-check without emitting files

## Bill.com API Documentation

For more information about the Bill.com API:

- [Bill.com Developer Portal](https://developer.bill.com)
- [API Reference](https://developer.bill.com/reference/api-reference-overview)
- [Authentication Guide](https://developer.bill.com/docs/authentication-with-api-token)

## Troubleshooting

### "API token not found" error

Make sure you have set the `BILL_API_TOKEN` environment variable in your `.env` file or in your system environment.

### Authentication failures

- Verify your API token is correct
- Check that you're using the correct environment (sandbox vs production)
- Ensure your token hasn't expired

### Connection issues

- Check your internet connection
- Verify Bill.com API is accessible
- Check if you're behind a proxy or firewall

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
