---
name: ping_host
description: >-
  Use this skill when the user wants to ping a host (e.g., a website, server, or
  IP) and measure its average response time. Supports IPv4, IPv6, domains, and
  custom packet counts.
license: None
---
# Ping Host: Measure Average Response Time

## Overview
This skill pings a specified host (e.g., `google.com`, `8.8.8.8`, or `localhost`) and calculates the **average response time** in milliseconds. It supports:
- IPv4 and IPv6 addresses
- Domain names
- Custom packet counts (default: 4)
- Linux, macOS, and Windows (with minor adaptations)

---

## How It Works
1. **Ping the host** using the system's `ping` command.
2. **Parse the output** to extract response times for each packet.
3. **Calculate the average** response time and display it.
4. **Handle errors** (e.g., host unreachable, invalid input).

---

## Commands
### Linux/macOS
```bash
ping -c <count> <host> | grep "time=" | awk -F'time=' '{print $2}' | awk '{print $1}' | awk '{sum+=$1; count++} END {if(count>0) print sum/count; else print "N/A"}'
```

### Windows
```cmd
ping -n <count> <host> | findstr "time=" | for /f "tokens=5 delims== " %i in ('findstr "time="') do @echo %i | for /f "delims=ms" %j in ('echo %i') do @echo %j | awk '{sum+=$1; count++} END {if(count>0) print sum/count; else print "N/A"}'
```

---

## Flags
| Flag | Description                          | Example               |
|------|--------------------------------------|-----------------------|
| `-c` | Number of packets to send (Linux/macOS) | `ping -c 5 google.com` |
| `-n` | Number of packets to send (Windows)    | `ping -n 5 google.com` |

---

## Examples
### Basic Usage
**Input:**
```
ping_host google.com
```

**Output:**
```
Pinging google.com...
Average response time: 12.34 ms
```

### Custom Packet Count
**Input:**
```
ping_host google.com -c 10
```

**Output:**
```
Pinging google.com (10 packets)...
Average response time: 11.87 ms
```

### IPv6 Address
**Input:**
```
ping_host 2607:f8b0:4009:80e::200e
```

**Output:**
```
Pinging 2607:f8b0:4009:80e::200e...
Average response time: 15.21 ms
```

---

## Notes
- **Permissions:** Ensure you have network access and permission to ping the target.
- **Firewalls:** Some hosts block ICMP requests (e.g., `ping`). If the host is unreachable, the skill will notify you.
- **Units:** Response times are in **milliseconds (ms)**.
- **Adaptability:** The skill can be extended to support additional flags (e.g., `-i` for interval, `-s` for packet size).

---

## Error Handling
| Error                     | Description                          | Solution                          |
|---------------------------|--------------------------------------|-----------------------------------|
| `ping: unknown host`      | Hostname is invalid or unreachable.  | Check the hostname/address.       |
| `100% packet loss`        | Host is blocking ICMP or offline.    | Verify network connectivity.      |
| `Permission denied`       | Lack of network permissions.         | Run with elevated privileges.     |

---

## Scripts
This skill includes a **supporting script** (`ping_host.sh`) to simplify execution. The script:
1. Validates input.
2. Runs the appropriate `ping` command.
3. Parses and calculates the average response time.
4. Handles errors gracefully.
