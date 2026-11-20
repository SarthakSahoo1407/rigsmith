// TONE3000 (https://www.tone3000.com): sign in with a device code, search the catalog, list a tone's
// models, and download one into the library on the user's request. Network calls run on a worker
// thread; completions come back on the message thread, which alone touches the settings.
//
// Terms we follow: only download when the user asks; keep creator, license and links with every
// file (the library sidecar) and show them; present it as TONE3000 ("Powered by TONE3000").

#pragma once
#include "Library.h"

namespace rig
{
class Tone3000
{
public:
    using Done = std::function<void (var)>;
    explicit Tone3000 (PropertiesFile& s) : settings (s) {}
    ~Tone3000() { *alive = false; }

    // { hasKey, signedIn, user }
    var status() const
    {
        auto* o = new DynamicObject();
        o->setProperty ("hasKey", settings.getValue ("t3kKey").isNotEmpty());
        o->setProperty ("signedIn", settings.getValue ("t3kRefresh").isNotEmpty());
        o->setProperty ("user", settings.getValue ("t3kUser"));
        return o;
    }

    void signOut()
    {
        for (auto k : { "t3kAccess", "t3kRefresh", "t3kExpires", "t3kUser" }) settings.removeValue (k);
    }

    // Device-code sign-in: `started` gets { userCode, url } (the browser opens on that page), then
    // `finished` gets the new status, or { error }.
    void signIn (Done started, Done finished)
    {
        const auto key = settings.getValue ("t3kKey");
        if (key.isEmpty()) { started (error ("Add your TONE3000 key in Settings first")); return; }
        run ([key] { return post ("/oauth/device_authorization", "client_id=" + enc (key) + "&scope=read"); },
             [this, key, started, finished] (var r) {
                 if (! r["device_code"].isString()) { started (errorFrom (r, "TONE3000 didn't start sign-in")); return; }
                 URL (r["verification_uri_complete"].toString()).launchInDefaultBrowser();
                 auto* o = new DynamicObject();
                 o->setProperty ("userCode", r["user_code"]);
                 o->setProperty ("url", r["verification_uri_complete"]);
                 started (var (o));
                 const auto code = r["device_code"].toString();
                 const int interval = jmax (1, (int) r["interval"]), expires = jmax (60, (int) r["expires_in"]);
                 run ([key, code, interval, expires] { return pollForToken (key, code, interval, expires); },
                      [this, finished] (var t) {
                          if (! keep (t)) { finished (errorFrom (t, "Sign-in didn't finish")); return; }
                          settings.setValue ("t3kUser", t["user"].toString());
                          finished (status());
                      });
             });
    }

    // query: { query, gears ("amp", "pedal", "amp-cab"...), format ("nam" | "ir"), sort, page }
    void search (const var& query, Done done)
    {
        StringPairArray params;
        for (auto k : { "query", "gears", "format", "sort", "page" })
            if (query[k].toString().isNotEmpty()) params.set (k, query[k].toString());
        params.set ("page_size", "25");
        const bool browse = query["query"].toString().isEmpty() && query["sort"].toString().isEmpty();
        api (browse && query["page"].toString().isEmpty() ? "/tones/trending" : "/tones/search", params, done);
    }

    void tone (const String& toneId, Done done) { api ("/tones/" + URL::addEscapeChars (toneId, true), {}, done); }

    // architecture: "" for A1 and custom models (the API's default), "2" for A2.
    void models (const String& toneId, const String& architecture, Done done)
    {
        StringPairArray params;
        params.set ("tone_id", toneId);
        if (architecture.isNotEmpty()) params.set ("architecture", architecture);
        params.set ("page_size", "100");
        api ("/models", params, done);
    }

    // Downloads one model of a tone into the library with its credits. `done` gets the library entry.
    void download (const var& tone, const var& model, Done done)
    {
        withToken ([tone, model] (const String& token) -> var {
            const auto res = fetchFile (model["model_url"].toString(), token);
            if (res.status != 200 || res.bytes.isEmpty())
                return error ("Downloading " + tone["title"].toString() + " failed (" + (res.status ? "HTTP " + String (res.status) : String ("no connection")) + ")");
            const bool ir = tone["format"].toString() == "ir";
            const auto title = tone["title"].toString(), name = model["name"].toString();
            // The model's own name when it already says the tone ("TS9 Drive 0 Tone 7"), else both.
            const auto full = name.isEmpty() || name == title ? title : name.startsWithIgnoreCase (title) ? name : title + " · " + name;
            const auto file = library::freshFile (ir ? "ir" : "nam", full.replace (" · ", " - "), ir ? ".wav" : ".nam");
            if (! file.replaceWithData (res.bytes.getData(), res.bytes.getSize())) return error ("Couldn't save the file");
            const auto user = tone["user"];
            auto* meta = new DynamicObject();
            meta->setProperty ("name", full);
            meta->setProperty ("source", "tone3000");
            meta->setProperty ("title", title);
            meta->setProperty ("toneId", tone["id"]);
            meta->setProperty ("modelId", model["id"]);
            meta->setProperty ("toneUrl", tone["url"]);
            meta->setProperty ("author", user["display_name"].isString() ? user["display_name"] : user["username"]);
            meta->setProperty ("authorUrl", user["url"]);
            meta->setProperty ("license", tone["license"]);
            meta->setProperty ("gear", tone["gear"]);
            meta->setProperty ("contentHash", model["content_hash"]);
            library::writeMeta (file, var (meta));
            return library::entry (file);
        }, done);
    }

private:
    PropertiesFile& settings;
    std::shared_ptr<std::atomic<bool>> alive = std::make_shared<std::atomic<bool>> (true);
    static constexpr const char* base = "https://www.tone3000.com/api/v1";

    struct Response { int status = 0; MemoryBlock bytes; var json() const { return JSON::parse (bytes.toString()); } };

    static String enc (const String& s) { return URL::addEscapeChars (s, true); }
    static var error (const String& msg) { auto* o = new DynamicObject(); o->setProperty ("error", msg); return o; }
    static var errorFrom (const var& r, const String& fallback)
    {
        return error (r["error"].isString() ? r["error_description"].toString().isNotEmpty() ? r["error_description"].toString() : r["error"].toString() : fallback);
    }

    static Response request (const String& url, const String& headers, const String& form)
    {
        Response r;
        auto u = form.isEmpty() ? URL (url) : URL (url).withPOSTData (form);
        auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                        .withExtraHeaders (headers + (form.isEmpty() ? "" : "\r\nContent-Type: application/x-www-form-urlencoded"))
                        .withConnectionTimeoutMs (20000)
                        .withStatusCode (&r.status);
        if (auto s = u.createInputStream (opts)) s->readIntoMemoryBlock (r.bytes);
        return r;
    }
    // A model file: TONE3000 may answer with a redirect to file storage. Follow it by hand, without
    // the sign-in token, which storage hosts reject (and shouldn't see).
    static Response fetchFile (const String& url, const String& token)
    {
        Response r;
        StringPairArray headers;
        auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                        .withExtraHeaders ("Authorization: Bearer " + token)
                        .withConnectionTimeoutMs (30000)
                        .withNumRedirectsToFollow (0)
                        .withResponseHeaders (&headers)
                        .withStatusCode (&r.status);
        if (auto s = URL (url).createInputStream (opts)) s->readIntoMemoryBlock (r.bytes);
        if (r.status < 300 || r.status >= 400) return r;
        String location;
        for (const auto& k : headers.getAllKeys()) if (k.equalsIgnoreCase ("location")) location = headers[k];
        if (location.isEmpty()) return r;
        Response next;
        auto plain = URL::InputStreamOptions (URL::ParameterHandling::inAddress).withConnectionTimeoutMs (30000).withStatusCode (&next.status);
        if (location.startsWith ("/")) location = "https://" + URL (url).getDomain() + location;
        if (auto s = URL (location).createInputStream (plain))
            s->readIntoMemoryBlock (next.bytes);
        return next;
    }

    static var post (const String& path, const String& form) { return request (String (base) + path, {}, form).json(); }

    static var pollForToken (const String& key, const String& code, int interval, int expires)
    {
        for (auto end = Time::getMillisecondCounter() + (uint32) expires * 1000; Time::getMillisecondCounter() < end;)
        {
            Thread::sleep (interval * 1000);
            auto t = post ("/oauth/token", "grant_type=" + enc ("urn:ietf:params:oauth:grant-type:device_code") + "&device_code=" + enc (code) + "&client_id=" + enc (key));
            const auto err = t["error"].toString();
            if (err == "authorization_pending") continue;
            if (err == "slow_down") { interval += 5; continue; }
            if (! t["access_token"].isString()) return t;
            const auto me = request (String (base) + "/user", "Authorization: Bearer " + t["access_token"].toString(), {}).json();
            t.getDynamicObject()->setProperty ("user", me["display_name"].isString() ? me["display_name"] : me["username"]);
            return t;
        }
        return error ("The sign-in code expired");
    }

    // Stores tokens from a token response (on the message thread). False if it holds none.
    bool keep (const var& t)
    {
        if (! t["access_token"].isString()) return false;
        settings.setValue ("t3kAccess", t["access_token"].toString());
        if (t["refresh_token"].isString()) settings.setValue ("t3kRefresh", t["refresh_token"].toString());
        settings.setValue ("t3kExpires", (double) Time::currentTimeMillis() + 1000.0 * (double) jmax (60, (int) t["expires_in"]));
        return true;
    }

    void run (std::function<var()> work, Done done)
    {
        auto flag = alive;
        Thread::launch ([work, done, flag] {
            auto r = work();
            MessageManager::callAsync ([r, done, flag] { if (*flag) done (r); });
        });
    }

    // Runs `work` with a valid access token, refreshing it first when it has expired.
    void withToken (std::function<var (const String&)> work, Done done)
    {
        const auto key = settings.getValue ("t3kKey"), refresh = settings.getValue ("t3kRefresh");
        if (refresh.isEmpty()) { done (error ("Sign in to TONE3000 first")); return; }
        const bool fresh = settings.getDoubleValue ("t3kExpires") > (double) Time::currentTimeMillis() + 30000.0;
        const auto access = settings.getValue ("t3kAccess");
        run ([=] {
            var tokens;
            auto token = access;
            if (! fresh)
            {
                tokens = post ("/oauth/token", "grant_type=refresh_token&refresh_token=" + enc (refresh) + "&client_id=" + enc (key));
                if (! tokens["access_token"].isString()) return errorFrom (tokens, "Your TONE3000 sign-in expired; sign in again");
                token = tokens["access_token"].toString();
            }
            auto* o = new DynamicObject();
            o->setProperty ("result", work (token));
            o->setProperty ("tokens", tokens);
            return var (o);
        }, [this, done] (var r) {
            if (r["error"].isString()) { if (r["error"].toString().contains ("sign in again")) signOut(); done (r); return; }
            keep (r["tokens"]);
            done (r["result"]);
        });
    }

    void api (const String& path, const StringPairArray& params, Done done)
    {
        withToken ([path, params] (const String& token) -> var {
            URL u (String (base) + path);
            for (const auto& k : params.getAllKeys()) u = u.withParameter (k, params[k]);
            const auto r = request (u.toString (true), "Authorization: Bearer " + token + "\r\nContent-Type: application/json", {});
            if (r.status == 429) return error ("TONE3000 is rate-limiting searches; wait a minute");
            if (r.status != 200) return error ("TONE3000 answered " + String (r.status));
            return r.json();
        }, done);
    }
};
} // namespace rig
