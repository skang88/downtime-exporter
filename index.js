const express = require('express');
const mysql = require('mysql2/promise');
const promClient = require('prom-client');
const moment = require('moment-timezone');

// --- Configuration ---
// 환경 변수를 통해 데이터베이스 연결 정보를 설정하는 것이 좋습니다.

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, 
    dateStrings: true // DATETIME 값을 문자열로 가져오도록 설정
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
    help: 'The time elapsed between the last two production events for a specific line.',
    labelNames: ['line'],
    registers: [register]
});


// --- Application Logic ---
const app = express();
// 각 테이블의 마지막으로 확인된 타임스탬프와 사이클 타임을 저장합니다.
let lastKnownTimestamps = {};
let lastKnownCycleTimes = {};

/**
 * 주기적으로 다운타임을 확인하고 메트릭을 업데이트합니다.
 */
async function checkDowntime() {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const todayShiftStart = moment().tz('America/New_York').startOf('day').add(7, 'hours');

        for (const table of tablesToMonitor) {
            let downtimeToLog = 0;
            let lastProdTimeToLog = 'N/A';

            // --- Initialization Logic (runs only if lastKnownTimestamps[table] is not set) ---
            if (!lastKnownTimestamps[table]) {
                const initSql = `SELECT 
                                timestamp 
                                FROM ${dbConfig.database}.${table} 
                                WHERE timestamp >= ? 
                                ORDER BY timestamp DESC LIMIT 2`;
                const [initRows] = await connection.execute(initSql, [todayShiftStart.format('YYYY-MM-DD HH:mm:ss')]);

                if (initRows.length > 0) {
                    initRows.reverse(); 
                    const lastTs = moment.tz(initRows[initRows.length - 1].timestamp, 'America/New_York').toDate();

                    if (initRows.length === 2) {
                        const secondLastTs = moment.tz(initRows[0].timestamp, 'America/New_York').toDate();
                        const cycleTimeSeconds = (lastTs.getTime() - secondLastTs.getTime()) / 1000;

                        if (cycleTimeSeconds > 0) {
                            cycleTimeGauge.labels(table).set(cycleTimeSeconds);
                            lastKnownCycleTimes[table] = cycleTimeSeconds;
                        }
                    }
                    lastKnownTimestamps[table] = lastTs; 
                } else {
                    lastKnownTimestamps[table] = todayShiftStart.toDate();
                }
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
                const [newRows] = await connection.execute(sql, [moment.tz(lastSeenTimestamp, 'America/New_York').format('YYYY-MM-DD HH:mm:ss')]);
                const newTimestamps = newRows.map(row => moment.tz(row.timestamp, 'America/New_York').toDate());

                if (newTimestamps.length > 0) {
                    let previousTimestampInBatch = lastKnownTimestamps[table];
                    for (const currentTimestamp of newTimestamps) {
                        const cycleTimeSeconds = (currentTimestamp.getTime() - previousTimestampInBatch.getTime()) / 1000;
                        if (cycleTimeSeconds > 0) {
                            cycleTimeGauge.labels(table).set(cycleTimeSeconds);
                            lastKnownCycleTimes[table] = cycleTimeSeconds;
                        }
                        previousTimestampInBatch = currentTimestamp;
                    }
                    lastKnownTimestamps[table] = newTimestamps[newTimestamps.length - 1];
                }
            }

            // --- Ongoing downtime calculation ---
            const now = moment().tz('America/New_York');
            const currentHour = now.hours();
            const currentMinute = now.minutes();

            const isWorkingHours =
                (currentHour > 7 || (currentHour === 7 && currentMinute >= 0)) &&
                (currentHour < 15 || (currentHour === 15 && currentMinute <= 30));

            if (lastKnownTimestamps[table]) {
                lastProdTimeToLog = moment.tz(lastKnownTimestamps[table], 'America/New_York').format('YYYY-MM-DD HH:mm:ss');
                if (isWorkingHours) {
                    const lastProductionTime = moment.tz(lastKnownTimestamps[table], 'America/New_York');
                    const downtimeSeconds = now.diff(lastProductionTime, 'seconds');
                    downtimeToLog = downtimeSeconds > 0 ? downtimeSeconds : 0;
                    ongoingDowntimeGauge.labels(table).set(downtimeToLog);
                } else {
                    downtimeToLog = 0;
                    ongoingDowntimeGauge.labels(table).set(downtimeToLog);
                }
            } else {
                downtimeToLog = 0;
                ongoingDowntimeGauge.labels(table).set(downtimeToLog);
            }

            // --- Final Logging for this table ---
            const currentTime = now.format('HH:mm');
            console.log(
                `[${new Date().toISOString()}] Current Time: ${currentTime}, Is Working Hours: ${isWorkingHours}, ` +
                `Last Time ${table}: ${lastProdTimeToLog}, ` +
                `downtime "${table}"} ${downtimeToLog}, ` +
                `cycle_time "${table}"} ${lastKnownCycleTimes[table] || 'N/A'}`
            );
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