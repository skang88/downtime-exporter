const express = require('express');
const mysql = require('mysql2/promise');
const promClient = require('prom-client');

// --- Configuration ---
// 환경 변수를 통해 데이터베이스 연결 정보를 설정하는 것이 좋습니다.
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
};

const port = process.env.PORT || 8002;
const tablesToMonitor = ['F01', 'R01'];

// --- Prometheus Metrics ---
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Metric 1: 현재 진행중인 다운타임 (마지막 생산시간 ~ 현재시간)
const ongoingDowntimeGauge = new promClient.Gauge({
    name: 'production_ongoing_downtime_seconds',
    help: 'Ongoing downtime since the last production event for a specific line.',
    labelNames: ['line'],
    registers: [register]
});

// Metric 2: 과거 생산 사이클 시간 (직전 생산시간 ~ 마지막 생산시간)
const cycleTimeGauge = new promClient.Gauge({
    name: 'production_cycle_time_seconds',
    help: 'The time elapsed between the last two production events for a specific line. Displayed as NaN if it exceeds 5 minutes.',
    labelNames: ['line'],
    registers: [register]
});


// --- Application Logic ---
const app = express();
// 각 테이블의 마지막으로 확인된 타임스탬프를 저장합니다.
let lastKnownTimestamps = {};

/**
 * 주기적으로 다운타임을 확인하고 메트릭을 업데이트합니다.
 */
async function checkDowntime() {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        for (const table of tablesToMonitor) {

            // --- Initialization Logic (runs only if lastKnownTimestamps[table] is not set) ---
            if (!lastKnownTimestamps[table]) {
                const initSql = `SELECT 
                                timestamp 
                                FROM ${dbConfig.database}.${table} ORDER BY 
                                timestamp 
                                DESC LIMIT 2`;
                const [initRows] = await connection.execute(initSql);
                if (initRows.length === 2) {
                    const lastTs = new Date(initRows[0].timestamp);
                    const secondLastTs = new Date(initRows[1].timestamp);
                    const cycleTimeSeconds = (lastTs.getTime() - secondLastTs.getTime()) / 1000;

                    if (cycleTimeSeconds > 0) {
                        // 5분 (300초) 이상이면 비정상으로 보고 NaN으로 처리
                        if (cycleTimeSeconds > 300) {
                            cycleTimeGauge.labels(table).set(NaN);
                            console.log(`[${new Date().toISOString()}] Initial cycle time for ${table} is over 5 minutes (${cycleTimeSeconds}s). Setting to NaN.`);
                        } else {
                            cycleTimeGauge.labels(table).set(cycleTimeSeconds);
                            console.log(`[${new Date().toISOString()}] Initial cycle time for ${table} set to: ${cycleTimeSeconds}s`);
                        }
                    }
                    lastKnownTimestamps[table] = lastTs; // Set the starting point
                } else if (initRows.length === 1) {
                    lastKnownTimestamps[table] = new Date(initRows[0].timestamp); // Only one row exists, just set the starting point
                }
                console.log(`[${new Date().toISOString()}] Initial timestamp for ${table} loaded: ${lastKnownTimestamps[table]?.toISOString()}`);
            }

            // --- Main processing logic for new items (Cycle Time) ---
            const lastSeenTimestamp = lastKnownTimestamps[table];
            if (lastSeenTimestamp) {
                const sql = `SELECT 
                            timestamp 
                            FROM ${dbConfig.database}.${table} WHERE 
                            timestamp 
                            > ? ORDER BY 
                            timestamp 
                            ASC`;
                const [newRows] = await connection.execute(sql, [lastSeenTimestamp]);
                const newTimestamps = newRows.map(row => new Date(row.timestamp));

                if (newTimestamps.length > 0) {
                    let previousTimestampInBatch = lastKnownTimestamps[table];
                    for (const currentTimestamp of newTimestamps) {
                        const cycleTimeSeconds = (currentTimestamp.getTime() - previousTimestampInBatch.getTime()) / 1000;
                        if (cycleTimeSeconds > 0) {
                            // 5분 (300초) 이상이면 비정상으로 보고 NaN으로 처리
                            if (cycleTimeSeconds > 300) {
                                cycleTimeGauge.labels(table).set(NaN);
                                console.log(`[${new Date().toISOString()}] New production cycle for ${table} is over 5 minutes (${cycleTimeSeconds}s). Setting to NaN. (Item: ${currentTimestamp.toISOString()})`);
                            } else {
                                cycleTimeGauge.labels(table).set(cycleTimeSeconds);
                                console.log(`[${new Date().toISOString()}] New production cycle for ${table}: ${cycleTimeSeconds}s (Item: ${currentTimestamp.toISOString()})`);
                            }
                        }
                        previousTimestampInBatch = currentTimestamp;
                    }
                    // Update the global last known timestamp to the latest one from the batch
                    lastKnownTimestamps[table] = newTimestamps[newTimestamps.length - 1];
                }
            }

            // --- Ongoing downtime calculation ---
            const now = new Date();
            if (lastKnownTimestamps[table]) {
                const ongoingDowntimeSeconds = (now.getTime() - lastKnownTimestamps[table].getTime()) / 1000;
                ongoingDowntimeGauge.labels(table).set(ongoingDowntimeSeconds);
            } else {
                // 데이터가 아직 없으면 다운타임은 0
                ongoingDowntimeGauge.labels(table).set(0);
            }
        }
    } catch (error) {
        console.error('Database connection failed:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// --- Server Setup ---
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (ex) {
        res.status(500).end(ex);
    }
});

app.listen(port, () => {
    const pollingInterval = parseInt(process.env.POLLING_INTERVAL_MS || '10000', 10);
    console.log(`Downtime Exporter listening at http://localhost:${port}`);
    console.log(`Polling database every ${pollingInterval / 1000} seconds.`);
    // 주기적으로 다운타임 확인 시작
    setInterval(checkDowntime, pollingInterval);
    // 초기 실행
    checkDowntime();
});