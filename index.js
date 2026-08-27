require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise'); 
const sql = require('mssql'); 
const promClient = require('prom-client');
const moment = require('moment-timezone');

// --- Configuration ---
const dbConfig = { 
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, 
    dateStrings: true 
};

const mssqlConfig = { 
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_HOST, 
    database: process.env.MSSQL_DATABASE,
    port: Number(process.env.MSSQL_PORT) || 1433,
    options: {
        encrypt: false, 
        trustServerCertificate: true 
    }
};

const port = process.env.PORT || 8002;
const tablesToMonitor = ['F01', 'R01', 'C01'];

// --- Prometheus Metrics ---
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const ongoingDowntimeGauge = new promClient.Gauge({
    name: 'production_ongoing_downtime_seconds',
    help: 'Ongoing downtime since the last production event for a specific line.',
    labelNames: ['line', 'model', 'status'],
    registers: [register]
});

// --- Application Logic ---
const app = express();
let lastKnownTimestamps = {};

async function checkDowntime() {
    let mysqlConnection;
    let mssqlConnection;
    try {
        mysqlConnection = await mysql.createConnection(dbConfig);
        mssqlConnection = await sql.connect(mssqlConfig);

        const now = moment().tz('America/New_York');
        const currentHour = now.hours();
        const currentMinute = now.minutes();
        const currentTotalMinutes = currentHour * 60 + currentMinute;

        // [핵심 1] 새벽 0시 ~ 7시 사이라면, 현재 시프트는 '전날 저녁에 시작된 야간조'입니다.
        // 따라서 MS SQL 생산 계획(RDATE)도 전날 날짜로 조회해야 새벽에 0으로 떨어지지 않습니다.
        const isPastMidnight = currentHour < 7;
        const targetRDate = isPastMidnight 
            ? now.clone().subtract(1, 'days').format('YYYYMMDD') 
            : now.format('YYYYMMDD');

        let todayShiftStart = now.clone().startOf('day').add(7, 'hours');
        if (isPastMidnight) {
            todayShiftStart.subtract(1, 'days');
        }

        for (const table of tablesToMonitor) {
            // --- Fetch Production Plan and Actual Production from MS SQL ---
            const productionPlanQuery = `
                SELECT ISNULL(SUM(PL_QTY), 0) AS TotalPlan, ISNULL(SUM(RH_QTY), 0) AS TotalWorked
                FROM SAG.dbo.PRD_PRDPDPF
                WHERE RDATE = @rdate
                  AND LTRIM(RTRIM(WRK_CD)) = @lineCode;
            `;
            const request = mssqlConnection.request();
            request.input('rdate', sql.VarChar, targetRDate); // 자정 보정된 날짜 적용
            request.input('lineCode', sql.NVarChar, table); 
            const result = await request.query(productionPlanQuery);
            const { TotalPlan, TotalWorked } = result.recordset[0];

            if (TotalPlan === 0) {
                if (lastKnownTimestamps[table] && lastKnownTimestamps[table].model) {
                    const lastModel = lastKnownTimestamps[table].model;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);
                }
                ongoingDowntimeGauge.remove(table, '', 'production_complete');
                ongoingDowntimeGauge.remove(table, '', 'no_production_data');
                lastKnownTimestamps[table] = undefined; 
                continue; 
            }

            if (TotalWorked >= TotalPlan) {
                if (lastKnownTimestamps[table] && lastKnownTimestamps[table].model) {
                    const lastModel = lastKnownTimestamps[table].model;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);
                }
                ongoingDowntimeGauge.remove(table, '', 'no_production');
                ongoingDowntimeGauge.remove(table, '', 'no_production_data');
                lastKnownTimestamps[table] = undefined; 
                continue; 
            }

            if (lastKnownTimestamps[table] && moment.tz(lastKnownTimestamps[table].timestamp, 'America/New_York').isBefore(todayShiftStart)) {
                lastKnownTimestamps[table] = undefined;
            }

            let downtimeToLog = 0;
            let lastProdTimeToLog = 'N/A';

            if (!lastKnownTimestamps[table]) {
                const initSql = `SELECT timestamp, model FROM SPC.${table} WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 2`;
                const [initRows] = await mysqlConnection.execute(initSql, [todayShiftStart.format('YYYY-MM-DD HH:mm:ss')]);

                if (initRows.length > 0) {
                    initRows.reverse(); 
                    const lastProdEvent = initRows[initRows.length - 1];
                    const lastTs = moment.tz(lastProdEvent.timestamp, 'America/New_York').toDate();
                    const lastModel = lastProdEvent.model || 'unknown'; 
                    lastKnownTimestamps[table] = { timestamp: lastTs, model: lastModel }; 
                } else {
                    lastKnownTimestamps[table] = undefined;
                }
            }

            const lastKnownProdEvent = lastKnownTimestamps[table];
            if (lastKnownProdEvent) {
                const sqlQuery = `SELECT timestamp, model FROM SPC.${table} WHERE timestamp > ? ORDER BY timestamp ASC`;
                const [newRows] = await mysqlConnection.execute(sqlQuery, [moment.tz(lastKnownProdEvent.timestamp, 'America/New_York').format('YYYY-MM-DD HH:mm:ss')]);
                
                if (newRows.length > 0) {
                    let previousTimestampInBatch = lastKnownProdEvent.timestamp;
                    let previousModelInBatch = lastKnownProdEvent.model;

                    for (const currentProdEvent of newRows) {
                        const currentTimestamp = moment.tz(currentProdEvent.timestamp, 'America/New_York').toDate();
                        const currentModel = currentProdEvent.model || 'unknown';

                        if (currentModel !== previousModelInBatch) {
                            ongoingDowntimeGauge.remove(table, previousModelInBatch, 'working_hours');
                        }

                        previousTimestampInBatch = currentTimestamp;
                        previousModelInBatch = currentModel;
                    }
                    lastKnownTimestamps[table] = { timestamp: previousTimestampInBatch, model: previousModelInBatch };
                }
            }

            // --- [핵심 2] 근무 및 휴게 시간 판별 (아침 7시 ~ 다음날 새벽 2시) ---
            // 주간조: 07:00 (420분) ~ 17:30 (1050분)
            const isDayShift = currentTotalMinutes >= 420 && currentTotalMinutes <= 1050;

            // 야간조: 17:30 (1050분) ~ 자정(1440분) 및 자정 ~ 새벽 2시(120분)
            const isNightShift = (currentTotalMinutes >= 1050 && currentTotalMinutes <= 1439) || 
                                   (currentTotalMinutes >= 0 && currentTotalMinutes < 120);

            const isWorkingHours = isDayShift || isNightShift;

            // 휴게 시간 판별 (점심 11:00~11:30, 저녁 21:30~22:00)
            const isDayLunch = isDayShift && (currentTotalMinutes >= 660 && currentTotalMinutes < 690);       // 11:00 ~ 11:30
            const isNightDinner = isNightShift && (currentTotalMinutes >= 1290 && currentTotalMinutes < 1320); // 21:30 ~ 22:00

            const isLunchBreak = isDayLunch || isNightDinner;

            if (!isLunchBreak) {
                ongoingDowntimeGauge.remove(table, lastKnownTimestamps[table]?.model || '', 'lunch_break');
            }

            if (lastKnownTimestamps[table]) {
                const lastProdEvent = lastKnownTimestamps[table];
                const lastProductionTime = moment.tz(lastProdEvent.timestamp, 'America/New_York');
                const lastModel = lastProdEvent.model;

                lastProdTimeToLog = lastProductionTime.format('YYYY-MM-DD HH:mm:ss');
                
                if (isWorkingHours && !isLunchBreak) {
                    ongoingDowntimeGauge.remove(table, '', 'no_production');
                    ongoingDowntimeGauge.remove(table, '', 'production_complete');
                    ongoingDowntimeGauge.remove(table, '', 'no_production_data');

                    let effectiveLastProductionTime = lastProductionTime;
                    
                    // 점심 휴게 종료(11:30) 및 저녁 휴게 종료(22:00) 시간 보정
                    const lunchBreakEnd = moment(lastProductionTime).tz('America/New_York').hour(11).minute(30).second(0);
                    const dinnerBreakEnd = moment(lastProductionTime).tz('America/New_York').hour(22).minute(0).second(0);

                    if (lastProductionTime.isBefore(lunchBreakEnd) && now.isAfter(lunchBreakEnd)) {
                        effectiveLastProductionTime = lunchBreakEnd;
                    } else if (lastProductionTime.isBefore(dinnerBreakEnd) && now.isAfter(dinnerBreakEnd)) {
                        effectiveLastProductionTime = dinnerBreakEnd;
                    }

                    const downtimeSeconds = now.diff(effectiveLastProductionTime, 'seconds');
                    downtimeToLog = downtimeSeconds > 0 ? downtimeSeconds : 0;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(downtimeToLog);
                } else {
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);

                    let statusLabel = 'non_working_hours';
                    if (isLunchBreak) {
                        statusLabel = 'lunch_break';
                    }
                    downtimeToLog = 0;
                    ongoingDowntimeGauge.labels(table, lastModel, statusLabel).set(downtimeToLog);
                }
            } else {
                downtimeToLog = 0;
                ongoingDowntimeGauge.labels(table, '', 'no_production_data').set(downtimeToLog);
                ongoingDowntimeGauge.remove(table, '', 'no_production');
                ongoingDowntimeGauge.remove(table, '', 'production_complete');
            }

            const currentTime = now.format('HH:mm');
            console.log(
                `[${new Date().toISOString()}] Current Time: ${currentTime}, Is Working Hours: ${isWorkingHours}, ` +
                `Last Time ${table}: ${lastProdTimeToLog}, ` +
                `downtime "${table}": ${downtimeToLog}, ` +
                `Plan: ${TotalPlan}, Worked: ${TotalWorked}`
            );
        }
    } catch (error) {
        console.error('Database connection failed - Full Error:', error);
    } finally {
        if (mysqlConnection) await mysqlConnection.end();
        if (mssqlConnection) await mssqlConnection.close();
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
    setInterval(checkDowntime, pollingInterval);
    checkDowntime();
});