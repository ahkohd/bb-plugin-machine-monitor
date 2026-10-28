#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct IOReportSubscription *IOReportSubscriptionRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef matching);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
extern CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t timestamp);
extern double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);

extern CFDictionaryRef IOReportCopyChannelsInGroup(CFStringRef group, CFStringRef subgroup, uint64_t a, uint64_t b, uint64_t c);
extern IOReportSubscriptionRef IOReportCreateSubscription(void *allocator, CFMutableDictionaryRef channels, CFMutableDictionaryRef *subscribed, uint64_t channelId, CFTypeRef options);
extern CFDictionaryRef IOReportCreateSamples(IOReportSubscriptionRef subscription, CFMutableDictionaryRef channels, CFTypeRef options);
extern int64_t IOReportSimpleGetIntegerValue(CFDictionaryRef channel, int32_t index);
extern CFStringRef IOReportChannelGetChannelName(CFDictionaryRef channel);
extern CFStringRef IOReportChannelGetUnitLabel(CFDictionaryRef channel);

enum { TEMPERATURE_EVENT = 15, SAMPLE_MS = 250 };

typedef struct { char major, minor, build, reserved; uint16_t release; } SmcVersion;
typedef struct { uint16_t version, length; uint32_t cpuLimit, gpuLimit, memoryLimit; } SmcLimits;
typedef struct { uint32_t dataSize, dataType; char dataAttributes; } SmcKeyInfo;
typedef struct {
  uint32_t key;
  SmcVersion version;
  SmcLimits limits;
  SmcKeyInfo keyInfo;
  char result, status, data8;
  uint32_t data32;
  unsigned char bytes[32];
} SmcCall;

enum { SMC_READ_KEY = 5, SMC_KEY_AT_INDEX = 8, SMC_KEY_INFO = 9, SMC_STRUCT_METHOD = 2 };

static uint32_t four_char_code(const char *text) {
  return ((uint32_t)text[0] << 24) | ((uint32_t)text[1] << 16) | ((uint32_t)text[2] << 8) | (uint32_t)text[3];
}

static int smc_call(io_connect_t connection, SmcCall *input, SmcCall *output) {
  size_t size = sizeof(SmcCall);
  memset(output, 0, sizeof(SmcCall));
  return IOConnectCallStructMethod(connection, SMC_STRUCT_METHOD, input, sizeof(SmcCall), output, &size) == KERN_SUCCESS && output->result == 0;
}

static int smc_key_info(io_connect_t connection, uint32_t key, SmcKeyInfo *info) {
  SmcCall input = {0}, output;
  input.key = key;
  input.data8 = SMC_KEY_INFO;
  if (!smc_call(connection, &input, &output)) return 0;
  *info = output.keyInfo;
  return 1;
}

static int smc_read(io_connect_t connection, uint32_t key, SmcKeyInfo info, unsigned char *bytes) {
  SmcCall input = {0}, output;
  input.key = key;
  input.keyInfo.dataSize = info.dataSize;
  input.data8 = SMC_READ_KEY;
  if (!smc_call(connection, &input, &output)) return 0;
  memcpy(bytes, output.bytes, sizeof output.bytes);
  return 1;
}

static void read_smc_temperatures(int dump, double *cpu, double *gpu) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!service) return;
  io_connect_t connection;
  kern_return_t opened = IOServiceOpen(service, mach_task_self(), 0, &connection);
  IOObjectRelease(service);
  if (opened != KERN_SUCCESS) return;
  SmcKeyInfo countInfo;
  unsigned char bytes[32];
  uint32_t keyCount = 0;
  if (smc_key_info(connection, four_char_code("#KEY"), &countInfo) && smc_read(connection, four_char_code("#KEY"), countInfo, bytes)) {
    keyCount = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | bytes[3];
  }
  double cpuSum = 0, gpuSum = 0;
  int cpuCount = 0, gpuCount = 0;
  for (uint32_t index = 0; index < keyCount; index++) {
    SmcCall input = {0}, output;
    input.data8 = SMC_KEY_AT_INDEX;
    input.data32 = index;
    if (!smc_call(connection, &input, &output)) continue;
    uint32_t key = output.key;
    char name[5] = { (char)(key >> 24), (char)(key >> 16), (char)(key >> 8), (char)key, 0 };
    if (name[0] != 'T') continue;
    int isCpu = name[1] == 'p' || name[1] == 'e';
    int isGpu = name[1] == 'g';
    if (!isCpu && !isGpu && !dump) continue;
    SmcKeyInfo info;
    if (!smc_key_info(connection, key, &info) || info.dataType != four_char_code("flt ") || info.dataSize != 4) continue;
    if (!smc_read(connection, key, info, bytes)) continue;
    float celsius;
    memcpy(&celsius, bytes, sizeof celsius);
    if (dump) printf("smc\t%s\t%.2f\n", name, celsius);
    if (!(celsius > 0 && celsius <= 150) || celsius == (float)(int)celsius) continue;
    if (isCpu) { cpuSum += celsius; cpuCount++; }
    if (isGpu) { gpuSum += celsius; gpuCount++; }
  }
  IOServiceClose(connection);
  if (cpuCount) *cpu = cpuSum / cpuCount;
  if (gpuCount) *gpu = gpuSum / gpuCount;
}

static int name_has(const char *name, const char *needle) {
  return strstr(name, needle) != NULL;
}

static int number_dictionary_entry(CFMutableDictionaryRef dictionary, const char *key, int value) {
  CFStringRef cfKey = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
  CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &value);
  CFDictionarySetValue(dictionary, cfKey, number);
  CFRelease(cfKey);
  CFRelease(number);
  return 0;
}

static void read_temperatures(int dump, double *cpu, double *gpu) {
  double cpuSum = 0, gpuSum = 0;
  int cpuCount = 0, gpuCount = 0;
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) return;
  CFMutableDictionaryRef matching = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  number_dictionary_entry(matching, "PrimaryUsagePage", 0xff00);
  number_dictionary_entry(matching, "PrimaryUsage", 5);
  IOHIDEventSystemClientSetMatching(client, matching);
  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  if (services) {
    for (CFIndex index = 0; index < CFArrayGetCount(services); index++) {
      IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, index);
      CFTypeRef product = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
      char name[128] = "";
      if (product && CFGetTypeID(product) == CFStringGetTypeID()) {
        CFStringGetCString((CFStringRef)product, name, sizeof name, kCFStringEncodingUTF8);
      }
      if (product) CFRelease(product);
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, TEMPERATURE_EVENT, 0, 0);
      if (!event) continue;
      double celsius = IOHIDEventGetFloatValue(event, TEMPERATURE_EVENT << 16);
      CFRelease(event);
      if (dump) printf("sensor\t%s\t%.2f\n", name, celsius);
      if (!(celsius > 0 && celsius <= 150)) continue;
      if (name_has(name, "tdie") || name_has(name, "pACC") || name_has(name, "eACC")) {
        cpuSum += celsius;
        cpuCount++;
      } else if (name_has(name, "GPU")) {
        gpuSum += celsius;
        gpuCount++;
      }
    }
    CFRelease(services);
  }
  CFRelease(matching);
  CFRelease(client);
  if (cpuCount) *cpu = cpuSum / cpuCount;
  if (gpuCount) *gpu = gpuSum / gpuCount;
}

static double joules(int64_t value, CFStringRef unit) {
  char label[16] = "";
  if (unit) CFStringGetCString(unit, label, sizeof label, kCFStringEncodingUTF8);
  if (strcmp(label, "mJ") == 0) return value / 1e3;
  if (strcmp(label, "uJ") == 0) return value / 1e6;
  if (strcmp(label, "nJ") == 0) return value / 1e9;
  return -1;
}

static void read_power(int dump, double *cpu, double *gpu) {
  CFDictionaryRef channels = IOReportCopyChannelsInGroup(CFSTR("Energy Model"), NULL, 0, 0, 0);
  if (!channels) return;
  CFMutableDictionaryRef mutableChannels = CFDictionaryCreateMutableCopy(NULL, 0, channels);
  CFMutableDictionaryRef subscribed = NULL;
  IOReportSubscriptionRef subscription = IOReportCreateSubscription(NULL, mutableChannels, &subscribed, 0, NULL);
  if (!subscription || !subscribed) {
    CFRelease(mutableChannels);
    CFRelease(channels);
    return;
  }
  uint64_t startedAt = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
  CFDictionaryRef first = IOReportCreateSamples(subscription, subscribed, NULL);
  usleep(SAMPLE_MS * 1000);
  CFDictionaryRef second = IOReportCreateSamples(subscription, subscribed, NULL);
  double seconds = (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - startedAt) / 1e9;
  CFArrayRef before = first ? CFDictionaryGetValue(first, CFSTR("IOReportChannels")) : NULL;
  CFArrayRef after = second ? CFDictionaryGetValue(second, CFSTR("IOReportChannels")) : NULL;
  double cpuJoules = 0, gpuJoules = 0, gpuFallbackJoules = 0;
  int cpuSeen = 0, gpuSeen = 0, gpuFallbackSeen = 0;
  CFIndex count = before && after ? CFArrayGetCount(before) : 0;
  if (after && CFArrayGetCount(after) != count) count = 0;
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef start = CFArrayGetValueAtIndex(before, index);
    CFDictionaryRef end = CFArrayGetValueAtIndex(after, index);
    char name[128] = "";
    CFStringRef channelName = IOReportChannelGetChannelName(end);
    if (channelName) CFStringGetCString(channelName, name, sizeof name, kCFStringEncodingUTF8);
    double energy = joules(IOReportSimpleGetIntegerValue(end, 0) - IOReportSimpleGetIntegerValue(start, 0), IOReportChannelGetUnitLabel(end));
    if (dump) printf("energy\t%s\t%.4f J\n", name, energy);
    if (energy < 0) continue;
    if (strcmp(name, "GPU Energy") == 0) {
      gpuJoules += energy;
      gpuSeen = 1;
    } else if (strcmp(name, "GPU") == 0) {
      gpuFallbackJoules += energy;
      gpuFallbackSeen = 1;
    } else if (name_has(name, "CPU Energy")) {
      cpuJoules += energy;
      cpuSeen = 1;
    }
  }
  if (!gpuSeen && gpuFallbackSeen) {
    gpuJoules = gpuFallbackJoules;
    gpuSeen = 1;
  }
  if (cpuSeen && seconds > 0) *cpu = cpuJoules / seconds;
  if (gpuSeen && seconds > 0) *gpu = gpuJoules / seconds;
  if (second) CFRelease(second);
  if (first) CFRelease(first);
  CFRelease(subscribed);
  CFRelease(mutableChannels);
  CFRelease(channels);
}

static void print_number(const char *key, double value, int last) {
  if (!isfinite(value) || value < 0) printf("\"%s\":null%s", key, last ? "" : ",");
  else printf("\"%s\":%.2f%s", key, value, last ? "" : ",");
}

int main(int argc, char **argv) {
  int dump = argc > 1 && strcmp(argv[1], "--dump") == 0;
  double cpuTemp = -1, gpuTemp = -1, cpuWatts = -1, gpuWatts = -1;
  read_smc_temperatures(dump, &cpuTemp, &gpuTemp);
  if (cpuTemp < 0) read_temperatures(dump, &cpuTemp, &gpuTemp);
  read_power(dump, &cpuWatts, &gpuWatts);
  if (dump) return 0;
  printf("{");
  print_number("cpuTempC", cpuTemp, 0);
  print_number("gpuTempC", gpuTemp, 0);
  print_number("cpuWatts", cpuWatts, 0);
  print_number("gpuWatts", gpuWatts, 1);
  printf("}\n");
  return 0;
}
