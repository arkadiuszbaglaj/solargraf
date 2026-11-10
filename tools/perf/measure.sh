#!/usr/bin/env bash
# Pomiar bazowy wydajności serwera SolarGraf — do porównania przed i po optymalizacji.
#
# Tylko odczyt: nic nie zmienia w bazie, plikach ani kontenerach. Zapytania SQL działają
# w transakcji READ ONLY. Wynik to linie „klucz: wartość” (łatwe do porównania diffem).
#
#   bash measure.sh [sekundy]          # host i HTTP — bez uprawnień
#   sudo bash measure.sh [sekundy]     # dodatkowo kontenery, logi, bufor agenta i baza
#   sudo bash measure.sh baza          # tylko kontenery, bufor agenta i baza (bez okna pomiaru)
#
# Domyślne okno pomiaru CPU/dysku: 60 s. Adres: SOLARGRAF_URL (domyślnie https://localhost).
set -u

MODE=pelny
if [ "${1:-}" = baza ]; then MODE=baza; set --; fi
WINDOW=${1:-60}
URL=${SOLARGRAF_URL:-https://localhost}
RUNS=${SOLARGRAF_HTTP_RUNS:-20}
HZ=$(getconf CLK_TCK)

say() { printf '%s: %s\n' "$1" "$2"; }
section() { printf '\n## %s\n' "$1"; }

section "meta"
say czas_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
say okno_s "$WINDOW"
say root "$([ "$(id -u)" -eq 0 ] && echo tak || echo nie)"
say tryb "$MODE"

if [ "$MODE" = pelny ]; then
section "host"
say cpu_rdzenie "$(nproc)"
say kernel "$(uname -r)"
awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/ {printf "%s_MiB: %d\n", $1, $2/1024}' /proc/meminfo | tr -d ':' | sed 's/_MiB/_MiB:/'
say load_1_5_15 "$(cut -d' ' -f1-3 /proc/loadavg)"
say dysk_root "$(df -h / | awk 'NR==2 {print $3" / "$2" ("$5")"}')"
say uptime_s "$(cut -d' ' -f1 /proc/uptime)"

# --- CPU procesów i zapis na dysk w oknie pomiaru ---
# Procesy grupowane po nazwie (comm); postgres to suma wszystkich procesów bazy.
proc_ticks() {
  for stat in /proc/[0-9]*/stat; do
    # comm może zawierać spacje — pole w nawiasach; reszta po ostatnim „)”.
    line=$(cat "$stat" 2>/dev/null) || continue
    comm=${line#*(}; comm=${comm%)*}
    rest=${line##*) }
    set -- $rest
    # rest: $1=state ... utime=$12 stime=$13 (pola 14 i 15 /proc/pid/stat)
    printf '%s %s\n' "$comm" "$(( ${12} + ${13} ))"
  done | awk '{t[$1]+=$2} END {for (c in t) print c, t[c]}'
}
total_ticks() { awk '/^cpu / {s=0; for (i=2;i<=NF;i++) s+=$i; print s}' /proc/stat; }
idle_ticks() { awk '/^cpu / {print $5+$6}' /proc/stat; }
# Całe dyski fizyczne (bez partycji, loop i device-mappera) — nazwy z /sys/block.
DISKS=$(ls /sys/block | grep -vE '^(loop|ram|dm-|zram|sr)' | tr '
' ' ')
disk_sectors() { awk -v d=" $DISKS" 'index(d, " " $3 " ") {r+=$6; w+=$10} END {print r+0, w+0}' /proc/diskstats; }

before_procs=$(proc_ticks); t0=$(total_ticks); i0=$(idle_ticks); read -r dr0 dw0 <<<"$(disk_sectors)"
[ "$(id -u)" -eq 0 ] && command -v docker >/dev/null && \
  docker_io0=$(docker stats --no-stream --format '{{.Name}} {{.BlockIO}}' 2>/dev/null)
sleep "$WINDOW"
after_procs=$(proc_ticks); t1=$(total_ticks); i1=$(idle_ticks); read -r dr1 dw1 <<<"$(disk_sectors)"

section "cpu_okno"
busy=$(( (t1 - t0) - (i1 - i0) ))
awk -v b="$busy" -v t="$((t1 - t0))" 'BEGIN {printf "host_cpu_zajete_proc: %.1f\n", 100*b/t}'
# % jednego rdzenia (100 = jeden rdzeń w pełni).
join <(sort <<<"$before_procs") <(sort <<<"$after_procs") | awk -v hz="$HZ" -v w="$WINDOW" '
  { d=$3-$2; if (d>0) printf "cpu_%s_proc_rdzenia: %.2f\n", $1, 100*d/hz/w }' | sort -t: -k2 -rn | head -15

section "dysk_okno"
awk -v r="$((dr1 - dr0))" -v w="$((dw1 - dw0))" -v s="$WINDOW" \
  'BEGIN {printf "dysk_odczyt_KiB_s: %.1f\ndysk_zapis_KiB_s: %.1f\n", r*512/1024/s, w*512/1024/s}'

section "pamiec_procesow_RSS_MiB"
ps -eo rss=,comm= | awk '{m[$2]+=$1} END {for (c in m) if (m[c] > 10240) printf "rss_%s_MiB: %.0f\n", c, m[c]/1024}' | sort

# --- HTTP (bez logowania — publiczne zasoby) ---
section "http"
http_times() {  # $1 nazwa, $2 ścieżka, $3 nagłówek kodowania
  local name=$1 path=$2 enc=${3:-}
  local times=() size="" code=""
  for _ in $(seq "$RUNS"); do
    out=$(curl -sk -o /dev/null ${enc:+-H "Accept-Encoding: $enc"} \
      -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}' "$URL$path") || continue
    read -r code ttfb total size <<<"$out"
    times+=("$total")
  done
  printf '%s\n' "${times[@]}" | sort -n | awk -v n="$name" -v c="$code" -v s="$size" '
    {a[NR]=$1} END {
      if (NR == 0) { printf "http_%s: blad\n", n; exit }
      printf "http_%s_kod: %s\nhttp_%s_bajty: %s\n", n, c, n, s
      printf "http_%s_ms_mediana: %.1f\nhttp_%s_ms_p95: %.1f\n", n, a[int((NR+1)/2)]*1000, n, a[int(NR*0.95+0.5)]*1000 }'
}
http_times health /api/health
http_times ready /api/health/ready
http_times index / "zstd, gzip"
index=$(curl -sk "$URL/")
for asset in $(grep -oE '/assets/[^"]+\.(js|css)' <<<"$index" | sort -u); do
  name=$(basename "$asset" | sed -E 's/-[A-Za-z0-9_-]{8}\./_./; s/\.(js|css)$/_\1/; s/[^A-Za-z0-9_]/_/g')
  http_times "$name" "$asset" "zstd, gzip"
  raw=$(curl -sk -o /dev/null -w '%{size_download}' "$URL$asset")
  say "http_${name}_bajty_bez_kompresji" "$raw"
done
say http_js_pliki_w_index "$(grep -oE '/assets/[^"]+\.js' <<<"$index" | sort -u | wc -l)"
fi  # MODE=pelny

if [ "$(id -u)" -ne 0 ] || ! command -v docker >/dev/null; then
  printf '\n# Bez sudo: pominięto kontenery, logi, bufor agenta i bazę.\n'
  exit 0
fi

# --- kontenery ---
section "kontenery"
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.BlockIO}}' | \
  awk '{printf "kontener_%s: cpu=%s pamiec=%s%s blockio=%s%s%s\n", $1, $2, $3, $4 $5, $6, $7, $8}'
printf '%s\n' "${docker_io0:-}" | awk 'NF {printf "kontener_%s_blockio_start: %s %s %s\n", $1, $2, $3, $4}'
for c in $(docker ps -a --filter label=com.docker.compose.project=solargraf --format '{{.Names}}'); do
  say "kontener_${c}_restarty" "$(docker inspect -f '{{.RestartCount}} stan={{.State.Status}} zdrowie={{if .State.Health}}{{.State.Health.Status}}{{else}}brak{{end}}' "$c")"
  log=$(docker inspect -f '{{.LogPath}}' "$c")
  [ -n "$log" ] && [ -f "$log" ] && say "kontener_${c}_log_MiB" "$(du -m "$log" | cut -f1)"
  say "kontener_${c}_log_limit" "$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}}' "$c")"
done
say docker_obrazy_i_wolumeny "$(docker system df --format '{{.Type}}={{.Size}}' | tr '\n' ' ')"

container() { docker ps -q --filter label=com.docker.compose.project=solargraf --filter "label=com.docker.compose.service=$1" | head -1; }

# --- bufor agenta ---
section "agent_bufor"
agent=$(container agent)
if [ -n "$agent" ]; then
  docker exec "$agent" sh -c 'ls -l /var/lib/solargraf-agent' | awk 'NR>1 {printf "agent_plik_%s_bajty: %s\n", $9, $5}'
  # Tylko SELECT; stdin zamknięty — docker exec nie czeka na terminal.
  docker exec "$agent" python -c '
import glob, sqlite3
for path in sorted(glob.glob("/var/lib/solargraf-agent/*.sqlite3")):
    db = sqlite3.connect(path)
    rows = db.execute("SELECT count(*), min(created_at) FROM runs").fetchone()
    print("agent_bufor_cykli:", rows[0], "najstarszy:", rows[1])
' </dev/null 2>&1 | sed 's/^Traceback.*/agent_bufor_cykli: blad odczytu/' | grep '^agent_bufor'
fi

# --- baza ---
section "baza"
db=$(container db)
[ -z "$db" ] && { say baza "brak kontenera"; exit 0; }
# Z -c bez -i: inaczej docker exec czeka na koniec stdin (terminal) i skrypt staje.
psql() {
  if [ "${1:-}" = -c ]; then
    docker exec "$db" psql -U solargraf -d solargraf -v ON_ERROR_STOP=1 -qAt "$@" </dev/null
  else
    docker exec -i "$db" psql -U solargraf -d solargraf -v ON_ERROR_STOP=1 -qAt "$@"
  fi
}

psql <<'SQL'
SELECT 'baza_rozmiar_MiB: ' || pg_database_size('solargraf') / 1048576;
SELECT 'tabela_' || relname || '_MiB: ' || round(pg_total_relation_size(c.oid) / 1048576.0, 1)
       || ' wiersze~' || reltuples::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND pg_total_relation_size(c.oid) > 1048576
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20;
SELECT 'pomiary_wierszy_24h: ' || count(*) FROM measurements WHERE received_at >= now() - interval '24 hours';
SELECT 'cykle_wierszy: ' || count(*) FROM polling_runs;
SELECT 'urzadzenia: ' || count(*) FROM devices;
SELECT 'instalacje: ' || count(*) FROM sites;
SELECT 'polaczenia_aktywne: ' || count(*) FROM pg_stat_activity WHERE datname = 'solargraf';
SELECT 'cache_hit_proc: ' || round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2)
FROM pg_stat_database WHERE datname = 'solargraf';
SELECT 'seq_scan_' || relname || ': ' || seq_scan || ' idx_scan=' || coalesce(idx_scan, 0)
FROM pg_stat_user_tables WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 8;
SQL

# Zapytania z kodu (stan na 0.17.0) — czas wykonania w bazie. Każde 3 razy; liczy się ostatnie
# (rozgrzany cache), jak przy kolejnych żądaniach w działającej aplikacji.
explain() {  # $1 nazwa, stdin: zapytanie
  local name=$1 sql result
  sql=$(cat)
  for _ in 1 2 3; do
    result=$(psql -c "BEGIN READ ONLY; EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) $sql; ROLLBACK;" 2>&1)
  done
  say "sql_${name}_ms" "$(grep -oE 'Execution Time: [0-9.]+' <<<"$result" | awk '{print $3}')"
  say "sql_${name}_bufory" "$(grep -m1 -oE 'Buffers: shared [^)]*' <<<"$result" | head -1 | sed 's/Buffers: shared //')"
  say "sql_${name}_plan" "$(grep -oE '(Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan) (using [a-z0-9_]+ )?on [a-z0-9_]+' <<<"$result" | sort -u | paste -sd ',')"
}

site=$(psql -c "SELECT site_id FROM measurements WHERE received_at >= now() - interval '1 hour' GROUP BY site_id ORDER BY count(*) DESC LIMIT 1")
if [ -z "$site" ]; then
  say sql "brak świeżych pomiarów — pominięto zapytania"
  exit 0
fi

# 1. Migawka widoku na żywo (live.py, load_snapshot) — przy każdym połączeniu SSE.
explain live_migawka <<SQL
SELECT DISTINCT ON (device_id, metric, channel) device_id, metric, channel, value, quality, origin, received_at
FROM measurements WHERE site_id = '$site' AND received_at >= now() - interval '24 hours'
ORDER BY device_id, metric, channel, received_at DESC
SQL

# 2. Ostatnie cykle w alarmach (alarm_rules.py) — co minutę w workerze.
explain alarmy_cykle_15min <<'SQL'
SELECT device_id, count(*), count(*) FILTER (WHERE failed_points > 0), max(failed_points),
       max(ok_points + failed_points)
FROM polling_runs WHERE started_at >= now() - interval '15 minutes' GROUP BY device_id
SQL

# 3. Pochodzenie danych energii (energy_api.py) — przy każdym pobraniu energii; dzień i rok.
pairs=$(psql -c "SELECT string_agg(format('(device_id = %L AND metric = %L)', device_id, metric), ' OR ')
  FROM (SELECT DISTINCT device_id, metric FROM measurements
        WHERE site_id = '$site' AND received_at >= now() - interval '1 hour'
          AND metric IN ('pv_energy_total','grid_import_energy_total','grid_export_energy_total',
                         'battery_charge_energy_total','battery_discharge_energy_total','load_power')) s")
if [ -n "$pairs" ]; then
  explain energia_pochodzenie_dzien <<SQL
SELECT DISTINCT origin FROM measurements WHERE ($pairs)
  AND received_at >= date_trunc('day', now()) AND received_at < date_trunc('day', now()) + interval '1 day'
ORDER BY origin
SQL
  explain energia_pochodzenie_rok <<SQL
SELECT DISTINCT origin FROM measurements WHERE ($pairs)
  AND received_at >= now() - interval '365 days' AND received_at < now()
ORDER BY origin
SQL
else
  say sql_energia "brak metryk energii — pominięto"
fi

# 4. Moc 5 min dla zużycia, rok (energy_api.py, _power_m5).
explain energia_m5_rok <<SQL
SELECT bucket_start, avg, coverage FROM aggregates
WHERE device_id = (SELECT device_id FROM measurements WHERE site_id = '$site' AND metric = 'load_power'
                   AND received_at >= now() - interval '1 hour' LIMIT 1)
  AND metric = 'load_power' AND channel = 0 AND resolution = 'M5'
  AND bucket_start >= now() - interval '365 days' AND bucket_start < now()
ORDER BY bucket_start
SQL

# 5. Liczenie surowych odczytów do wyboru rozdzielczości historii (history.py) — doba.
explain historia_licz_doba <<SQL
SELECT count(*) FROM measurements
WHERE (device_id, metric, channel) = (SELECT device_id, metric, channel FROM measurements
                                      WHERE site_id = '$site' AND received_at >= now() - interval '1 hour' LIMIT 1)
  AND received_at >= now() - interval '24 hours' AND received_at < now()
SQL
