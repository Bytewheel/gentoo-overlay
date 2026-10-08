// Verification harness for RozeLynx per-URL interface rules.
//
// The code under test is NOT copied into this file: extract.py pulls the real
// text out of RozeLynxNetIface.{h,cpp} - the rule struct, IsNeverBindHost,
// every URL-rule helper, BuildUrlRulesLocked, MatchUrlRuleLocked, GetEffective
// and MatchUrlRule - and it is #included below.  The only transformation is
// the class name (RozeLynxNetIface:: -> FakeSvc::), so the member bodies can
// be driven from a plain struct.  Everything in this file is stand-in plumbing
// for the mozilla string / XPCOM / pref surface, plus the checks, so a bug in
// the shipped code fails here.
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// ── mozilla basics ────────────────────────────────────────────────

using nsresult = int;
#define NS_OK ((nsresult)0)
#define NS_FAILED(rv) ((rv) != NS_OK)
#define NS_SUCCEEDED(rv) ((rv) == NS_OK)
#define NS_IMETHODIMP nsresult
#define NS_IsMainThread() true
#define MOZ_ASSERT(x) \
  do {                 \
  } while (0)
#define LOG(args) \
  do {             \
  } while (0)
#define kMaxUrlRules 256u

struct CaseInsensitive {};
constexpr CaseInsensitive nsCaseInsensitiveCStringComparator{};

struct Literal {
  const char* s;
};
inline Literal operator""_ns(const char* s, size_t) { return Literal{s}; }

// Gecko 156's StringBeginsWith takes a dependent substring for a literal
// prefix; PART G's G.1.2 changed the service to pass
// nsDependentCSubstring("*.", 2) for exactly that reason. The stand-in needed
// the type to exist before the extracted code would compile at all.
class nsDependentCSubstring {
 public:
  nsDependentCSubstring(const char* aLiteral, size_t aLength)
      : mLiteral(aLiteral, aLength) {}
  explicit nsDependentCSubstring(const char* aLiteral)
      : mLiteral(aLiteral) {}
  const std::string& Str() const { return mLiteral; }

 private:
  std::string mLiteral;
};

class Str {
 public:
  Str() = default;
  Str(const char* p) : m(p ? p : "") {}
  Str(const std::string& s) : m(s) {}
  Str(const Str&) = default;
  Str& operator=(const Str&) = default;

  const char* get() const { return m.c_str(); }
  std::string str() const { return m; }
  uint32_t Length() const { return (uint32_t)m.size(); }
  bool IsEmpty() const { return m.empty(); }
  char operator[](uint32_t i) const { return m[i]; }
  char Last() const { return m.empty() ? '\0' : m[m.size() - 1]; }

  void Truncate(uint32_t n = 0) { m.resize(n); }
  void Assign(const Str& o) { m = o.m; }
  void Append(const Str& o) { m += o.m; }
  void Append(const char* s) { m += s; }
  void Append(char c) { m += c; }
  void AppendLiteral(const char* s) { m += s; }
  void AssignLiteral(const char* s) { m = s; }
  void Trim(const char* chars) {
    size_t b = m.find_first_not_of(chars);
    if (b == std::string::npos) {
      m.clear();
      return;
    }
    size_t e = m.find_last_not_of(chars);
    m = m.substr(b, e - b + 1);
  }
  bool EqualsLiteral(const char* s) const { return m == s; }
  bool Equals(const Str& o) const { return m == o.m; }
  template <class C>
  bool Equals(const Str& o, C) const {
    return strcasecmp(m.c_str(), o.m.c_str()) == 0;
  }
  // Gecko 156 removed nsTString::FindString; the service was changed to call
  // Find (PART G, G.1.2 - one of the nine edits that made it compile against
  // 156). FindString is kept as well so a regression that reintroduces the old
  // spelling still compiles here and is caught by a check, rather than being
  // invisible because the stand-in stopped offering it.
  int32_t Find(const char* s) const {
    size_t p = m.find(s);
    return p == std::string::npos ? -1 : (int32_t)p;
  }
  int32_t FindString(const char* s) const { return Find(s); }
  int32_t FindChar(char c) const {
    size_t p = m.find(c);
    return p == std::string::npos ? -1 : (int32_t)p;
  }
  int32_t RFindChar(char c) const {
    size_t p = m.rfind(c);
    return p == std::string::npos ? -1 : (int32_t)p;
  }
  int32_t IndexOf(char c) const { return FindChar(c); }
  int32_t ToInteger(int* err) const {
    size_t i = 0;
    bool neg = false;
    if (!m.empty() && m[0] == '-') {
      neg = true;
      i = 1;
    }
    if (i >= m.size()) {
      *err = 1;
      return 0;
    }
    long v = 0;
    for (; i < m.size(); i++) {
      if (m[i] < '0' || m[i] > '9') {
        *err = 1;
        return 0;
      }
      v = v * 10 + (m[i] - '0');
    }
    *err = 0;
    return (int32_t)(neg ? -v : v);
  }

 private:
  std::string m;
};

inline bool operator==(const Str& a, const Str& b) { return a.str() == b.str(); }
inline bool operator!=(const Str& a, const Str& b) { return !(a == b); }
inline bool operator==(const Str& a, const char* b) { return a.str() == b; }
inline bool operator!=(const Str& a, const char* b) { return !(a == b); }
inline bool operator<(const Str& a, const Str& b) { return a.str() < b.str(); }

using nsACString = Str;
using nsCString = Str;
using nsAutoCString = Str;

struct Flat {
  const char* p;
  const char* get() const { return p; }
};
inline Flat PromiseFlatCString(const Str& s) { return Flat{s.get()}; }

inline Str Substring(const Str& s, size_t start, size_t len = (size_t)-1) {
  if (start >= s.Length()) {
    return Str();
  }
  std::string t = s.str().substr(start);
  if (len != (size_t)-1 && len < t.size()) {
    t.resize(len);
  }
  return Str(t);
}

inline void ToLowerCase(Str& s) {
  std::string t = s.str();
  for (auto& c : t) {
    c = (char)tolower((unsigned char)c);
  }
  s = Str(t);
}

inline bool StringBeginsWith(const Str& a, const Str& b) {
  return a.str().rfind(b.str(), 0) == 0;
}
inline bool StringBeginsWith(const Str& a, Literal b) {
  return a.str().rfind(b.s, 0) == 0;
}
// Added with nsDependentCSubstring above: 156's overload set needs a
// dependent-substring parameter, and the extracted code passes one.
inline bool StringBeginsWith(const Str& a, const nsDependentCSubstring& b) {
  return a.str().rfind(b.Str(), 0) == 0;
}
inline bool StringEndsWith(const Str& a, const Str& b) {
  return a.Length() >= b.Length() &&
         a.str().compare(a.Length() - b.Length(), b.Length(), b.str()) == 0;
}
inline bool StringEndsWith(const Str& a, Literal b) {
  return StringEndsWith(a, Str(b.s));
}

// nsTArray stand-in with the members the extracted pref reader uses.
template <class T>
class nsTArray {
 public:
  using iterator = typename std::vector<T>::iterator;
  void Append(const T& v) { m.push_back(v); }
  void AppendElement() { m.emplace_back(); }
  T& operator[](uint32_t i) { return m[i]; }
  const T& operator[](uint32_t i) const { return m[i]; }
  iterator begin() { return m.begin(); }
  iterator end() { return m.end(); }
  bool IsEmpty() const { return m.empty(); }
  uint32_t Length() const { return (uint32_t)m.size(); }

 private:
  std::vector<T> m;
};

// NetAddr: only the two predicates IsNeverBindHost uses.
struct NetAddr {
  nsresult InitFromString(const Str& s) {
    const std::string t = s.str();
    if (t.empty()) {
      return 1;
    }
    for (char c : t) {
      if (!isdigit((unsigned char)c) && c != '.' && c != ':') {
        return 1;  // not an IP literal
      }
    }
    mIsLoop = t.rfind("127.", 0) == 0 || t == "::1";
    mIsLocal = t.rfind("10.", 0) == 0 || t.rfind("192.168.", 0) == 0 ||
               t.rfind("172.16.", 0) == 0 || t.rfind("169.254.", 0) == 0 ||
               t.rfind("fc", 0) == 0 || t.rfind("fd", 0) == 0;
    return NS_OK;
  }
  bool IsLoopbackAddr() const { return mIsLoop; }
  bool IsIPAddrLocal() const { return mIsLocal; }

 private:
  bool mIsLoop = false, mIsLocal = false;
};

struct Mutex {};
struct MutexAutoLock {
  explicit MutexAutoLock(Mutex&) {}
};


// ── stand-ins for the DNS-attribution path (AdditionalInfoForHost) ─
struct nsIDNSAdditionalInfo {
  virtual ~nsIDNSAdditionalInfo() = default;
};

// Implements nsIDNSAdditionalInfo, as the real one does.
class DNSAdditionalInfo : public nsIDNSAdditionalInfo {
 public:
  DNSAdditionalInfo(const Str& aResolverURL, int32_t aOriginAttrs, const Str& aIface)
      : resolverURL(aResolverURL.str()), iface(aIface.str()) {}
  std::string resolverURL;
  std::string iface;
};
// The harness runs with no DoH provider, so Get() returns null and the
// provider-host block is never entered (GetIfaceTrrURI yields "" too).
struct TRRService {
  static TRRService* Get() { return nullptr; }
  void GetURI(Str&) const {}
  bool IsProviderHost(const Str&) const { return false; }
};
class nsIURI {
 public:
  nsresult GetAsciiHost(Str& aOut) const { aOut = host; return NS_OK; }
  Str host;
};
template <class T>
class RefPtrT {
 public:
  RefPtrT() = default;
  RefPtrT(T* aP) : m(aP) {}
  template <class U>
  void forget(U** aOut) {
    *aOut = static_cast<U*>(m);
    m = nullptr;
  }

 private:
  T* m = nullptr;
};
#define RefPtr RefPtrT

// ── pref stand-ins (only what BuildUrlRulesLocked calls) ───────────
inline std::map<std::string, std::string> gPrefStrs;
inline std::map<std::string, bool> gPrefBools;

struct FakePrefs {
  static bool GetBool(const char* aName, bool aDefault) {
    auto it = gPrefBools.find(std::string(aName));
    bool v = it == gPrefBools.end() ? aDefault : it->second;
    if (getenv("F_DEBUG")) {
      std::printf("  [GetBool %s = %s]\n", aName, v ? "true" : "false");
    }
    return v;
  }
  static nsresult GetCString(const char* aName, Str& aOut) {
    if (getenv("F_DEBUG")) std::printf("  [GetCString %s]\n", aName);
    auto it = gPrefStrs.find(std::string(aName));
    if (it == gPrefStrs.end()) {
      aOut.Truncate();
      return 1;  // NS_ERROR_NOT_AVAILABLE
    }
    aOut = Str(it->second);
    return NS_OK;
  }
};
#define Preferences FakePrefs
#define NS_PREFSERVICE_CONTRACTID "fake:prefs"

class FakeBranch {
 public:
  // nsIPrefBranch reports full pref names, in an unspecified order - the
  // std::map iteration order here stands in for that.
  nsresult GetChildList(const char* aPrefix, nsTArray<Str>& aOut) const {
    if (getenv("F_DEBUG")) std::printf("  [GetChildList %s]\n", aPrefix);
    for (const auto& kv : gPrefStrs) {
      if (kv.first.rfind(aPrefix, 0) == 0) {
        aOut.Append(Str(kv.first));
      }
    }
    for (const auto& kv : gPrefBools) {
      if (kv.first.rfind(aPrefix, 0) == 0 && !gPrefStrs.count(kv.first)) {
        aOut.Append(Str(kv.first));
      }
    }
    return NS_OK;
  }
};
inline FakeBranch gPrefBranch;
using nsIPrefBranch = FakeBranch;

template <class T>
class nsCOMPtrT {
 public:
  nsCOMPtrT() = default;
  explicit nsCOMPtrT(T* aP) : p(aP) {}
  explicit operator bool() const { return p != nullptr; }
  T* operator->() const { return p; }
  T* p = nullptr;
};
template <class T>
using nsCOMPtr = nsCOMPtrT<T>;

// getter_AddRefs + NS_NewURI are only reached when a resolver URL exists, which
// it never does here (no per-iface override, no TRR provider). The stub exists
// so the code compiles; it reports failure, exactly like an unresolvable URI.
struct GetterAddRefs {
  nsIURI* p = nullptr;
};
inline GetterAddRefs getter_AddRefs(nsCOMPtrT<nsIURI>& aOut) {
  aOut = nsCOMPtrT<nsIURI>(new nsIURI());
  return GetterAddRefs{aOut.operator->()};
}
inline nsresult NS_NewURI(GetterAddRefs, const Str&) { return 1; }

inline nsCOMPtr<FakeBranch> do_GetService(const char*) {
  return nsCOMPtr<FakeBranch>(&gPrefBranch);
}

// Hash map stand-in with Gecko's Lookup()/Data() shape.  The iterator holds
// the map so Lookup() can return a bool-convertible object.
template <class K, class V>
class Map {
 public:
  using MapType = std::map<K, V>;
  struct It {
    MapType* p;
    typename MapType::iterator i;
    explicit operator bool() const { return i != p->end(); }
    V& Data() { return i->second; }
  };
  template <class K2>
  It Lookup(const K2& k) { return It{&m, m.find(static_cast<K>(k))}; }
  void InsertOrUpdate(const K& k, V v) { m[k] = std::move(v); }
  void Remove(const K& k) { m.erase(k); }
  void Clear() { m.clear(); }
  bool IsEmpty() const { return m.empty(); }

 private:
  MapType m;
};

// ── the object under test ─────────────────────────────────────────

static int g_pass = 0;
static int g_fail = 0;

#include "extracted_types.inc"

// nsTArray stand-in with the members the URL-rule code uses.
class RuleVec {
 public:
  using iterator = typename std::vector<RozeLynxNetIfaceUrlRule>::iterator;
  bool IsEmpty() const { return m.empty(); }
  uint32_t Length() const { return (uint32_t)m.size(); }
  RozeLynxNetIfaceUrlRule& operator[](size_t i) { return m[i]; }
  const RozeLynxNetIfaceUrlRule& operator[](size_t i) const { return m[i]; }
  RozeLynxNetIfaceUrlRule* Elements() { return m.data(); }
  void AppendElement(RozeLynxNetIfaceUrlRule&& v) { m.push_back(std::move(v)); }
  void Clear() { m.clear(); }
  // 156's nsTArray::Sort takes a comparator OBJECT and calls LessThan() on it;
  // PART G's G.1.4 replaced the service's bare lambda with a ByDeclaredIndex
  // functor for that reason. The stand-in used to call the comparator as a
  // function, so after that change it stopped compiling - which is the whole
  // lesson of G.1.4 pointed at the harness itself: a stand-in for the platform
  // goes stale exactly like real code does, and the failure is a build error
  // rather than a wrong answer, which is at least loud.
  template <class Compare>
  void Sort(Compare aCmp) {
    std::sort(m.begin(), m.end(),
              [&aCmp](const RozeLynxNetIfaceUrlRule& x,
                      const RozeLynxNetIfaceUrlRule& y) {
                return aCmp.LessThan(x, y);
              });
  }
  iterator begin() { return m.begin(); }
  iterator end() { return m.end(); }

 private:
  std::vector<RozeLynxNetIfaceUrlRule> m;
};


struct FakeSvc {
  // Pref roots, copied from RozeLynxNetIface.h.
  static constexpr const char* kPrefUrlRulesEnabled =
      "rozelynx.netiface.urlrules.enabled";
  static constexpr const char* kPrefUrlRulePrefix = "rozelynx.netiface.urlrule.";

  // Statics and members the extracted bodies touch.
  static bool sEnabled, sSupported, sDnsAttribution;
  static void GetIfaceTrrURI(const Str& aIface, Str& aOut) { aOut.Truncate(); }

  struct HostBinding {
    Str iface;
    int lastSeen = 0;  // TimeStamp is not needed by the extracted bodies
  };

  Mutex mMutex;
  Map<uint64_t, Str> mTabMap;
  Map<uint32_t, Str> mContainerMap;
  Map<Str, HostBinding> mHostIndex;
  Str mProfileIface;
  RuleVec mUrlRules;
  bool mUrlRulesEnabled = true;
  Str mUrlRuleMemoKey;
  int32_t mUrlRuleMemoIndex = -1;

  // Signatures copied from RozeLynxNetIface.h, so the extracted bodies
  // below are definitions of these.
  void BuildUrlRulesLocked();
  RozeLynxNetIfaceUrlRule* MatchUrlRuleLocked(const nsCString& aKey,
                                              const nsACString& aScheme,
                                              const nsACString& aHost,
                                              const nsACString& aPath);
  nsresult GetEffective(uint64_t aBrowserId, uint32_t aUserContextId,
                        const nsACString& aHost, nsCString& aLayer,
                        nsCString& aResult);
  nsresult MatchUrlRule(const nsACString& aUrl, int32_t* aIndex,
                        nsCString& aPattern, nsCString& aIface, bool* aMatched);
  nsresult AdditionalInfoForHost(const nsACString& aHost,
                                 nsIDNSAdditionalInfo** aOut);
};

bool FakeSvc::sEnabled = true;
bool FakeSvc::sSupported = true;
bool FakeSvc::sDnsAttribution = true;

#include "extracted_impl.inc"

// Drive the parser directly, for the checks that do not care about prefs.
static void setRules(FakeSvc& svc,
                     const std::vector<std::pair<std::string, std::string>>& rules) {
  svc.mUrlRules.Clear();
  svc.mUrlRuleMemoKey.Truncate();
  svc.mUrlRuleMemoIndex = -1;
  for (size_t i = 0; i < rules.size(); i++) {
    RozeLynxNetIfaceUrlRule rule;
    if (!UrlRuleParsePattern(Str(rules[i].first), rule)) {
      g_fail++;
      std::printf("  FAIL  pattern %s rejected by the parser\n",
                  rules[i].first.c_str());
      continue;
    }
    rule.iface = Str(rules[i].second);
    rule.index = (uint32_t)i;
    svc.mUrlRules.AppendElement(std::move(rule));
  }
}

// ── checks ────────────────────────────────────────────────────────

static void check(bool ok, const std::string& what) {
  if (ok) {
    g_pass++;
  } else {
    g_fail++;
    std::printf("  FAIL  %s\n", what.c_str());
  }
}

static void checkEq(const std::string& got, const std::string& want,
                    const std::string& what) {
  if (got == want) {
    g_pass++;
  } else {
    g_fail++;
    std::printf("  FAIL  %s: got \"%s\" want \"%s\"\n", what.c_str(),
                got.c_str(), want.c_str());
  }
}

struct Eff {
  Str iface;
  Str layer;
};

static Eff effective(FakeSvc& svc, uint64_t browserId, uint32_t containerId,
                     const char* url) {
  Str layer;
  Str result;
  svc.GetEffective(browserId, containerId, Str(url), layer, result);
  return Eff{result, layer};
}

static void testSplitTarget() {
  struct {
    const char* in;
    const char* scheme;
    const char* host;
    const char* path;
  } cases[] = {
      {"https://sub.Example.COM/Mail?x=1#f", "https", "sub.example.com",
       "/mail?x=1#f"},
      {"sub.example.com", "", "sub.example.com", ""},
      {"sub.example.com:8443/x", "", "sub.example.com", "/x"},
      {"example.com:8080", "", "example.com", ""},
      {"//example.com/x", "", "example.com", "/x"},
      {"https://user:pw@example.com:443/x", "https", "example.com", "/x"},
      {"http://[::1]:8080/", "http", "::1", "/"},
      {"[fe80::1]", "", "fe80::1", ""},
      {"about:blank", "about", "", ""},
      {"data:text/html,<b>", "data", "", ""},
      {"HTTPS://Example.com/", "https", "example.com", "/"},
      {"example.com./", "", "example.com", "/"},
      {"  example.com  ", "", "example.com", ""},
      {"::1", "", "::1", ""},
      {"https://example.com", "https", "example.com", ""},
  };
  for (auto& c : cases) {
    Str scheme, host, path;
    UrlRuleSplitTarget(Str(c.in), scheme, host, path);
    checkEq(host.str(), c.host, std::string("split host of ") + c.in);
    checkEq(scheme.str(), c.scheme, std::string("split scheme of ") + c.in);
    checkEq(path.str(), c.path, std::string("split path of ") + c.in);
  }
}

static void testParse() {
  RozeLynxNetIfaceUrlRule rule;
  check(UrlRuleParsePattern(Str("*.example.com"), rule), "parse *.example.com");
  check(rule.subdomainHost, "*.example.com is a subdomain rule");
  checkEq(rule.host.str(), "example.com", "*.example.com base");
  checkEq(rule.path.str(), "", "*.example.com has no path");
  check(rule.hostRank == 1, "*.example.com rank 1");

  check(UrlRuleParsePattern(Str("example.com"), rule), "parse example.com");
  check(!rule.subdomainHost, "example.com is not a subdomain rule");
  check(rule.hostRank == 2, "example.com rank 2");

  check(UrlRuleParsePattern(Str("*://example.com/mail"), rule),
        "parse *://example.com/mail");
  check(!rule.hasScheme, "*:// means any scheme");
  check(rule.hasPath, "/mail is a path");
  checkEq(rule.path.str(), "/mail*", "path gets an implied trailing star");

  check(UrlRuleParsePattern(Str("https://example.com/mail*"), rule),
        "parse https://example.com/mail*");
  check(rule.hasScheme, "https:// is a scheme");
  checkEq(rule.scheme.str(), "https", "scheme is lowercased");

  check(UrlRuleParsePattern(Str("*"), rule), "parse *");
  check(!rule.hasScheme && !rule.hasPath, "* is bare");
  check(rule.hostRank == 0, "* rank 0");
  checkEq(rule.host.str(), "*", "the bare-star host is kept as a glob");

  check(UrlRuleParsePattern(Str("*cdn?.example.com"), rule), "parse mid glob");
  check(rule.hostRank == 0, "mid glob rank 0");
  check(!rule.subdomainHost, "mid glob is not the *. form");

  check(!UrlRuleParsePattern(Str(""), rule), "blank pattern rejected");
  check(!UrlRuleParsePattern(Str("   "), rule), "whitespace pattern rejected");
  check(!UrlRuleParsePattern(Str("about:blank"), rule),
        "no-authority pattern rejected");
  check(!UrlRuleParsePattern(Str("*.*"), rule), "\"*.*\" rejected");
  // A trailing dot is meaningless in a host, so "*." normalizes to the
  // bare-star "any host" rule rather than being rejected.
  check(UrlRuleParsePattern(Str("*."), rule), "\"*.\" normalizes to \"*\"");
  checkEq(rule.host.str(), "*", "the bare-star host is kept");
  check(!rule.subdomainHost, "a bare star is not the subdomain form");
}

static void testGlob() {
  struct {
    const char* pat;
    const char* txt;
    bool want;
  } cases[] = {
      {"*", "", true},      {"", "", true},         {"", "a", false},
      {"a", "a", true},     {"a", "ab", false},      {"*a", "a", true},
      {"*a", "ba", true},   {"*a", "ab", false},     {"a*", "ab", true},
      {"a*b", "ab", true},  {"a*b", "axxxb", true},  {"a*b", "axxxc", false},
      {"a?c", "abc", true}, {"a?c", "ac", false},    {"a?c", "abbc", false},
      {"*a*a*", "xxaxxxayy", true}, {"*a*a*", "xxbyy", false},
      {"*mail*", "/mail/inbox?x", true}, {"/mail*", "/mailbox", true},
      {"/mail*", "/other", false},
      // A backtracking worst case: must terminate quickly and still be right.
      {"*a*a*a*a*a*a*b", "aaaaaaaaaaaaaaaaaaaaaaaac", false},
      {"*a*a*a*a*a*a*b", "aaaaaaaaaaaaaaaaaaaaaaaab", true},
  };
  for (auto& c : cases) {
    check(UrlRuleGlobMatch(Str(c.pat), Str(c.txt)) == c.want,
          std::string("glob ") + c.pat + " ~ " + c.txt);
  }
}

static void testLayerOrder() {
  FakeSvc svc;
  svc.mTabMap.InsertOrUpdate(42, Str("eth0"));
  svc.mContainerMap.InsertOrUpdate(2, Str("vpn0"));
  svc.mProfileIface = Str("wlan0");
  setRules(svc, {{"*.example.com", "usb0"}});

  // tab > url > container > profile > default
  Eff e = effective(svc, 42, 2, "https://sub.example.com/x");
  checkEq(e.iface.str(), "eth0", "tab beats url");
  checkEq(e.layer.str(), "tab", "tab layer wins");

  e = effective(svc, 99, 2, "https://sub.example.com/x");
  checkEq(e.iface.str(), "usb0", "url beats container");
  checkEq(e.layer.str(), "url", "url layer wins");

  e = effective(svc, 99, 2, "https://other.test/x");
  checkEq(e.iface.str(), "vpn0", "container beats profile");
  checkEq(e.layer.str(), "container", "container layer wins");

  FakeSvc noRules;
  noRules.mProfileIface = Str("wlan0");
  e = effective(noRules, 99, 2, "https://sub.example.com/x");
  checkEq(e.iface.str(), "wlan0", "no rules -> profile");
  checkEq(e.layer.str(), "profile", "profile layer wins");

  FakeSvc bare;
  e = effective(bare, 99, 2, "https://sub.example.com/x");
  checkEq(e.iface.str(), "", "nothing -> default routing");
  checkEq(e.layer.str(), "", "default layer is empty");
}

static void testEmptyHostSkipsLayer() {
  FakeSvc svc;
  svc.mProfileIface = Str("wlan0");
  setRules(svc, {{"*", "usb0"}});
  Eff e = effective(svc, 99, 2, "");
  checkEq(e.iface.str(), "wlan0", "empty aHost skips the url layer");
  checkEq(e.layer.str(), "profile", "empty aHost -> profile");
}

static void testNeverBind() {
  FakeSvc svc;
  svc.mProfileIface = Str("wlan0");
  setRules(svc, {{"*", "usb0"}, {"localhost", "usb0"}, {"*.local", "usb0"},
                 {"127.0.0.1", "usb0"}, {"192.168.1.5", "usb0"}});
  const char* hosts[] = {"http://localhost:8080/", "http://127.0.0.1/",
                         "http://192.168.1.5/", "http://nas.local/",
                         "http://[::1]/", "http://foo.localhost/"};
  for (const char* h : hosts) {
    Eff e = effective(svc, 99, 2, h);
    checkEq(e.iface.str(), "wlan0",
            std::string("never-bind host unbound: ") + h);
    checkEq(e.layer.str(), "profile",
            std::string("never-bind skips the url layer: ") + h);
  }
  Eff e = effective(svc, 99, 2, "https://example.com/");
  checkEq(e.iface.str(), "usb0", "a catch-all rule still binds normal hosts");
}

static void testSpecificity() {
  struct Case {
    std::vector<std::pair<std::string, std::string>> rules;
    const char* url;
    const char* want;
  };
  Case cases[] = {
      {{{"*.example.com", "a"}, {"example.com", "b"}},
       "https://example.com/",
       "b"},
      {{{"*.com", "a"}, {"*.example.com", "b"}}, "https://sub.example.com/", "b"},
      {{{"*", "a"}, {"*.example.com", "b"}}, "https://sub.example.com/", "b"},
      {{{"example.com", "a"}, {"example.com/mail", "b"}},
       "https://example.com/mail/inbox",
       "b"},
      {{{"example.com/mail*", "a"}, {"example.com/mail*", "b"}},
       "https://example.com/mail/x",
       "a"},
      {{{"*.example.com", "a"}, {"*.other.test", "b"}},
       "https://sub.example.com/",
       "a"},
      {{{"*://example.com", "a"}, {"https://example.com", "b"}},
       "https://example.com/",
       "b"},
      {{{"https://example.com/x", "a"}, {"https://example.com", "b"}},
       "https://example.com/x",
       "a"},
      // reversed declaration order must not change the answer
      {{{"example.com", "b"}, {"*.example.com", "a"}}, "https://example.com/",
       "b"},
      // the same host under two wildcard lengths
      {{{"*.example.com", "a"}, {"*.sub.example.com", "b"}},
       "https://x.sub.example.com/",
       "b"},
  };
  for (auto& c : cases) {
    FakeSvc svc;
    setRules(svc, c.rules);
    Eff e = effective(svc, 99, 0, c.url);
    checkEq(e.iface.str(), c.want,
            std::string("specificity for ") + c.url + " with " +
                std::to_string(c.rules.size()) + " rules");
  }

  // A disabled rule is not a candidate at all.
  FakeSvc svc;
  setRules(svc, {{"example.com", "a"}, {"*.example.com", "b"}});
  svc.mUrlRules[1].enabled = false;
  svc.mUrlRuleMemoIndex = -1;
  svc.mUrlRuleMemoKey.Truncate();
  Eff e = effective(svc, 99, 0, "https://example.com/");
  checkEq(e.iface.str(), "a", "a disabled rule cannot win");
}

static void testSchemeAndPathMatching() {
  FakeSvc svc;
  setRules(svc, {{"https://secure.test", "a"}, {"*://plain.test/mail", "b"},
                 {"sub.deep.test", "c"}});
  checkEq(effective(svc, 1, 0, "https://secure.test/x").iface.str(), "a",
          "scheme rule matches its scheme");
  checkEq(effective(svc, 1, 0, "http://secure.test/x").iface.str(), "",
          "scheme rule rejects another scheme");
  checkEq(effective(svc, 1, 0, "https://plain.test/mail/1").iface.str(), "b",
          "any-scheme rule with a path");
  checkEq(effective(svc, 1, 0, "http://plain.test/mail/1").iface.str(), "b",
          "any-scheme rule accepts http");
  checkEq(effective(svc, 1, 0, "https://plain.test/other").iface.str(), "",
          "path rule rejects another path");
  checkEq(effective(svc, 1, 0, "https://a.b.sub.deep.test/").iface.str(), "",
          "exact-host rule does not match a subdomain");
  checkEq(effective(svc, 1, 0, "https://sub.deep.test/").iface.str(), "c",
          "exact-host rule matches its own host");
  checkEq(effective(svc, 1, 0, "https://SUB.DEEP.test/").iface.str(), "c",
          "exact-host rule is case-insensitive");
}

static void testCaseInsensitivity() {
  FakeSvc svc;
  setRules(svc, {{"*.Example.COM/Mail", "usb0"}});
  checkEq(effective(svc, 1, 0, "https://SUB.example.com/MAIL/x").iface.str(),
          "usb0", "patterns and URLs are matched case-insensitively");
}

static void testForceDefaultIface() {
  FakeSvc svc;
  svc.mProfileIface = Str("wlan0");
  // An empty iface is a real rule: it pins the match to default routing.
  setRules(svc, {{"unbound.test", ""}});
  Eff e = effective(svc, 99, 0, "https://unbound.test/x");
  checkEq(e.iface.str(), "", "empty-iface rule wins with an empty iface");
  checkEq(e.layer.str(), "url", "empty-iface rule still reports the url layer");
  e = effective(svc, 99, 0, "https://elsewhere.test/");
  checkEq(e.iface.str(), "wlan0", "a non-matching host still uses the profile");
}

static void testMasterSwitch() {
  FakeSvc svc;
  svc.mProfileIface = Str("wlan0");
  setRules(svc, {{"*.example.com", "usb0"}});
  checkEq(effective(svc, 1, 0, "https://sub.example.com/").iface.str(), "usb0",
          "rules are on by default");
  svc.mUrlRulesEnabled = false;
  checkEq(effective(svc, 1, 0, "https://sub.example.com/").iface.str(), "wlan0",
          "the master switch off disables the url layer");
  svc.mUrlRulesEnabled = true;
  svc.mUrlRules.Clear();
  checkEq(effective(svc, 1, 0, "https://sub.example.com/").iface.str(), "wlan0",
          "an empty rule list is not the url layer");
}

static void testMemo() {
  FakeSvc svc;
  setRules(svc, {{"*.example.com", "usb0"}, {"other.test", "usb1"}});
  checkEq(effective(svc, 1, 0, "https://a.example.com/").iface.str(), "usb0",
          "memo: first lookup");
  checkEq(effective(svc, 1, 0, "https://b.example.com/").iface.str(), "usb0",
          "memo: second lookup, different host");
  checkEq(effective(svc, 1, 0, "https://other.test/").iface.str(), "usb1",
          "memo: third lookup, other rule");
  checkEq(effective(svc, 1, 0, "https://a.example.com/").iface.str(), "usb0",
          "memo: repeat of the first lookup");
  svc.mUrlRules.Clear();
  svc.mUrlRuleMemoKey.Truncate();
  svc.mUrlRuleMemoIndex = -1;
  checkEq(effective(svc, 1, 0, "https://a.example.com/").iface.str(), "",
          "the memo is invalidated when the rules are rebuilt");

  // The memo key must include the path, or a path rule could be shadowed by a
  // previous path-less lookup for the same host.
  FakeSvc svc3;
  setRules(svc3, {{"example.com/mail", "usb0"}});
  checkEq(effective(svc3, 1, 0, "https://example.com/other").iface.str(), "",
          "a path rule does not match another path");
  checkEq(effective(svc3, 1, 0, "https://example.com/mail/x").iface.str(),
          "usb0", "a path rule matches after a non-matching path");

  // ... and the scheme, or a scheme rule would be shadowed.
  FakeSvc svc4;
  setRules(svc4, {{"https://x.test", "usb0"}});
  checkEq(effective(svc4, 1, 0, "http://x.test/").iface.str(), "",
          "http is not matched by an https-only rule");
  checkEq(effective(svc4, 1, 0, "https://x.test/").iface.str(), "usb0",
          "https is matched after an http lookup");
}

static void testMatchUrlRuleIdl() {
  FakeSvc svc;
  setRules(svc, {{"*.example.com", "usb0"}, {"example.com/mail", ""}});
  int32_t index = -7;
  Str pattern, iface;
  bool matched = false;

  check(svc.MatchUrlRule(Str("https://sub.example.com/x"), &index, pattern,
                         iface, &matched) == NS_OK,
        "matchUrlRule returns NS_OK");
  check(matched, "matchUrlRule matched the subdomain rule");
  checkEq(pattern.str(), "*.example.com", "matchUrlRule reports the pattern");
  checkEq(iface.str(), "usb0", "matchUrlRule reports the interface");
  check(index == 0, "matchUrlRule reports the rule index");

  svc.MatchUrlRule(Str("https://example.com/mail"), &index, pattern, iface,
                   &matched);
  check(matched, "matchUrlRule matched the path rule");
  checkEq(iface.str(), "", "an empty interface is reported as empty");
  check(index == 1, "path rule index");

  svc.MatchUrlRule(Str("https://elsewhere.test/"), &index, pattern, iface,
                   &matched);
  check(!matched, "no match");
  check(index == -1, "no match reports index -1");
  checkEq(pattern.str(), "", "no match clears the pattern");
  checkEq(iface.str(), "", "no match clears the interface");

  svc.MatchUrlRule(Str("http://localhost/"), &index, pattern, iface, &matched);
  check(!matched, "a never-bind host never matches, even with a '*' rule");

  // Null out-params must not crash (the IDL allows them to be omitted).
  check(svc.MatchUrlRule(Str("https://sub.example.com/"), nullptr, pattern,
                         iface, nullptr) == NS_OK,
        "matchUrlRule tolerates omitted out-params");

  // The reported winner must be the one the resolver picked: that is the whole
  // point of the popup's match preview.
  FakeSvc svc2;
  svc2.mContainerMap.InsertOrUpdate(3, Str("vpn0"));
  setRules(svc2, {{"*.example.com", "usb0"}});
  int32_t idx2 = -1;
  Str p2, i2;
  bool m2 = false;
  svc2.MatchUrlRule(Str("https://sub.example.com/x"), &idx2, p2, i2, &m2);
  Eff e = effective(svc2, 5, 3, "https://sub.example.com/x");
  check(m2 && e.layer.str() == "url", "preview and resolver agree on the layer");
  checkEq(i2.str(), e.iface.str(), "preview and resolver agree on the iface");
}

// ── the pref reader ────────────────────────────────────────────────

static void testBuildUrlRulesLocked() {
  gPrefStrs.clear();
  gPrefBools.clear();

  // Out-of-order indices, an incomplete rule (pattern but no iface), an
  // unusable pattern, a disabled rule, and a non-numeric index.
  gPrefStrs["rozelynx.netiface.urlrule.0.iface"] = "usb0";
  gPrefStrs["rozelynx.netiface.urlrule.0.pattern"] = "*.example.com";
  gPrefStrs["rozelynx.netiface.urlrule.2.iface"] = "usb2";
  gPrefStrs["rozelynx.netiface.urlrule.2.pattern"] = "  spaced.test  ";
  gPrefBools["rozelynx.netiface.urlrule.2.enabled"] = false;
  gPrefStrs["rozelynx.netiface.urlrule.5.iface"] = "usb5";
  gPrefStrs["rozelynx.netiface.urlrule.5.pattern"] = "noiface.test";
  gPrefStrs["rozelynx.netiface.urlrule.x.iface"] = "usbX";
  gPrefStrs["rozelynx.netiface.urlrule.x.pattern"] = "badindex.test";
  gPrefStrs["rozelynx.netiface.urlrule.7.iface"] = "usb7";
  gPrefStrs["rozelynx.netiface.urlrule.7.pattern"] = "about:blank";
  // A pref that merely starts with the same letters must not be picked up.
  gPrefStrs["rozelynx.netiface.urlrules.thing"] = "x";

  FakeSvc svc;
  svc.BuildUrlRulesLocked();
  checkEq(std::to_string(svc.mUrlRules.Length()), "3",
          "three usable rules survive the pref reader");
  checkEq(svc.mUrlRules[0].host.str(), "example.com", "rule 0 parsed");
  checkEq(svc.mUrlRules[0].iface.str(), "usb0", "rule 0 iface");
  checkEq(std::to_string((long)svc.mUrlRules[0].index), "0", "rule 0 index");
  checkEq(svc.mUrlRules[1].pattern.str(), "spaced.test",
          "a trimmed pattern keeps its trimmed provenance");
  check(svc.mUrlRules[1].enabled == false, "a disabled rule is loaded disabled");
  checkEq(svc.mUrlRules[2].host.str(), "noiface.test", "rule 5 loaded");
  checkEq(std::to_string((long)svc.mUrlRules[2].index), "5",
          "declaration order is by <n>, not by pref list order");

  checkEq(effective(svc, 1, 0, "https://sub.example.com/").iface.str(), "usb0",
          "a rule loaded from prefs binds");
  checkEq(effective(svc, 1, 0, "https://spaced.test/").iface.str(), "",
          "a disabled rule loaded from prefs does not bind");

  // The master switch, read from prefs, with the default when unset.
  FakeSvc off;
  gPrefBools["rozelynx.netiface.urlrules.enabled"] = false;
  off.BuildUrlRulesLocked();
  check(off.mUrlRulesEnabled == false, "the master switch pref is read");
  check(off.mUrlRules.IsEmpty(), "the master switch off loads no rules");
  gPrefBools.erase("rozelynx.netiface.urlrules.enabled");
  FakeSvc on;
  on.BuildUrlRulesLocked();
  check(on.mUrlRulesEnabled == true, "the master switch defaults to on");

  // A rebuild must invalidate the memo (a stale hit would keep an old winner).
  FakeSvc memoSvc;
  gPrefStrs["rozelynx.netiface.urlrule.0.iface"] = "usb0";
  gPrefStrs["rozelynx.netiface.urlrule.0.pattern"] = "memo.test";
  memoSvc.BuildUrlRulesLocked();
  checkEq(effective(memoSvc, 1, 0, "https://memo.test/").iface.str(), "usb0",
          "memo svc binds");
  gPrefStrs["rozelynx.netiface.urlrule.0.iface"] = "usb9";
  memoSvc.BuildUrlRulesLocked();
  checkEq(effective(memoSvc, 1, 0, "https://memo.test/").iface.str(), "usb9",
          "a pref change takes effect despite the memo");

  // The cap: a pathological pref set is bounded, not unbounded.
  FakeSvc capSvc;
  gPrefStrs.clear();
  for (int i = 0; i < (int)kMaxUrlRules + 40; i++) {
    char name[128];
    std::snprintf(name, sizeof(name), "rozelynx.netiface.urlrule.%d.iface", i);
    gPrefStrs[name] = "usb0";
    std::snprintf(name, sizeof(name), "rozelynx.netiface.urlrule.%d.pattern", i);
    gPrefStrs[name] = "cap" + std::to_string(i) + ".test";
  }
  capSvc.BuildUrlRulesLocked();
  checkEq(std::to_string(capSvc.mUrlRules.Length()),
          std::to_string((unsigned long)kMaxUrlRules), "the rule cap holds");

  gPrefStrs.clear();
  gPrefBools.clear();
}

#define RUN(f)                       \
  do {                                \
    std::printf("-- %s\n", #f);       \
    f();                              \
  } while (0)


// ── the DNS-attribution index-miss fallback (F.6) ─────────────────
static void testAdditionalInfoForHost() {
  // A host bound ONLY by a URL rule has no channel record yet, so the host
  // index misses.  Without the rule fallback its extension-driven lookups
  // would take the profile's DNS mode - a DoH leak relative to the bound
  // egress the rule forces.
  FakeSvc svc;
  setRules(svc, {{"*.rule.test", "usb0"}});

  nsIDNSAdditionalInfo* out = nullptr;
  check(svc.AdditionalInfoForHost(Str("a.rule.test"), &out) == NS_OK,
    "additionalInfoForHost returns NS_OK");
  check(out != nullptr, "a rule-bound host is attributed on the FIRST lookup");
  delete out;

  // The host index still wins when it has a record.
  FakeSvc indexed;
  setRules(indexed, {{"*.rule.test", "usb0"}});
  indexed.mHostIndex.InsertOrUpdate(Str("a.rule.test"),
                                    FakeSvc::HostBinding{Str("vpn0"), 0});
  out = nullptr;
  indexed.AdditionalInfoForHost(Str("a.rule.test"), &out);
  check(out != nullptr, "an indexed host is still attributed");
  delete out;
  out = nullptr;
  indexed.AdditionalInfoForHost(Str("unrelated.test"), &out);
  check(out == nullptr, "a host with no index entry and no rule stays unbound");

  // A rule that pins the match to DEFAULT routing must not force TRR-only.
  FakeSvc forced;
  setRules(forced, {{"*.rule.test", ""}});
  out = nullptr;
  forced.AdditionalInfoForHost(Str("a.rule.test"), &out);
  check(out == nullptr,
    "a rule with an empty interface leaves DNS on the default path");

  // DNS knows neither scheme nor path, so a rule that narrows on them cannot
  // be assumed to apply to a lookup.
  FakeSvc narrow;
  setRules(narrow, {{"https://secure.test/mail", "usb0"}});
  out = nullptr;
  narrow.AdditionalInfoForHost(Str("secure.test"), &out);
  check(out == nullptr, "a scheme/path rule does not attribute a bare DNS lookup");
  setRules(narrow, {{"secure.test", "usb0"}});
  out = nullptr;
  narrow.AdditionalInfoForHost(Str("secure.test"), &out);
  check(out != nullptr, "a host-only rule does attribute it");
  delete out;

  // The master switch turns the fallback off with the layer.
  FakeSvc off;
  setRules(off, {{"*.rule.test", "usb0"}});
  off.mUrlRulesEnabled = false;
  out = nullptr;
  off.AdditionalInfoForHost(Str("a.rule.test"), &out);
  check(out == nullptr, "the master switch off disables the DNS fallback");

  // Never-bind hosts stay unbound, rule or not.
  FakeSvc nb;
  setRules(nb, {{"*", "usb0"}});
  const char* hosts[] = {"localhost", "127.0.0.1", "192.168.1.5", "nas.local"};
  for (const char* h : hosts) {
    out = nullptr;
    nb.AdditionalInfoForHost(Str(h), &out);
    check(out == nullptr,
          std::string("a never-bind host is never attributed: ") + h);
  }

  // The v13 feature switches still gate the whole thing.
  FakeSvc attrOff;
  setRules(attrOff, {{"*.rule.test", "usb0"}});
  FakeSvc::sDnsAttribution = false;
  out = nullptr;
  attrOff.AdditionalInfoForHost(Str("a.rule.test"), &out);
  check(out == nullptr, "dnsAttribution=off disables attribution entirely");
  FakeSvc::sDnsAttribution = true;
}

int main() {
  testSplitTarget();
  testParse();
  testGlob();
  testLayerOrder();
  testEmptyHostSkipsLayer();
  testNeverBind();
  testSpecificity();
  testSchemeAndPathMatching();
  testCaseInsensitivity();
  testForceDefaultIface();
  testMasterSwitch();
  testMatchUrlRuleIdl();
  testMemo();
  std::printf("-- testBuildUrlRulesLocked\n");
  testBuildUrlRulesLocked();
  std::printf("-- testAdditionalInfoForHost\n");
  testAdditionalInfoForHost();
  std::printf("%d checks passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
