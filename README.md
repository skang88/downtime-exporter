# Downtime Exporter

## Overview

This project is a Prometheus exporter that calculates and exposes machine downtime based on production data. It monitors specified production lines, checks against production plans, and calculates downtime during working hours.

The exporter connects to two databases:
- A **MySQL** database to read the production event logs for each line.
- A **Microsoft SQL Server** database to retrieve the daily production plan.

## Configuration

The application is configured via environment variables. Create a `.env` file in the root of the project with the following variables:

```
# Server Configuration
PORT=8002
POLLING_INTERVAL_MS=10000

# MySQL Database Configuration (for production data)
DB_HOST=your_mysql_host
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password
DB_DATABASE=SPC

# MS SQL Database Configuration (for production plan)
MSSQL_HOST=your_mssql_host
MSSQL_USER=your_mssql_user
MSSQL_PASSWORD=your_mssql_password
MSSQL_DATABASE=SAG
```

## How to Run

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Start the exporter:**
    ```bash
    node index.js
    ```

The exporter will start, and you will see log output in the console indicating its activity.

## Metrics

The Prometheus metrics are exposed on the `/metrics` endpoint.

-   **Endpoint:** `http://localhost:8002/metrics`

### Exposed Metrics

-   `production_ongoing_downtime_seconds`: A Prometheus Gauge that shows the current ongoing downtime in seconds for a specific production line.
    -   **Labels:**
        -   `line`: The production line identifier (e.g., `F01`, `R01`, `C01`).
        -   `model`: The model currently in production.
        -   `status`: The current status (e.g., `working_hours`, `lunch_break`, `non_working_hours`). Downtime is primarily tracked during `working_hours`.
