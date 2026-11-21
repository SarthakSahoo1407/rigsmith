// The text assistant's link to OpenRouter (https://openrouter.ai): one chat call and the list of free
// models. Network calls run on a worker thread and complete on the message thread. Nothing here
// touches the rig: the UI turns the reply into edits it checks itself. No platform-specific calls.

#pragma once
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace rig
{
class Llm
{
public:
    using Done = std::function<void (var)>;
    explicit Llm (PropertiesFile& s) : settings (s) {}
    ~Llm() { *alive = false; }

    // { hasKey, model }
    var status() const
    {
        auto* o = new DynamicObject();
        o->setProperty ("hasKey", settings.getValue ("orKey").isNotEmpty());
        o->setProperty ("model", model());
        return o;
    }

    // request: { messages: [{ role, content }] }. Done gets { text } or { error }.
    void chat (const var& request, Done done)
    {
        const auto key = settings.getValue ("orKey"), mdl = model();
        if (key.isEmpty()) { done (error ("Add your OpenRouter key in Settings first")); return; }
        auto* body = new DynamicObject();
        body->setProperty ("model", mdl);
        body->setProperty ("messages", request["messages"]);
        body->setProperty ("temperature", 0.2);
        body->setProperty ("max_tokens", 900);
        const auto json = JSON::toString (var (body), true);
        run ([key, json] {
            const auto r = send ("https://openrouter.ai/api/v1/chat/completions", "Authorization: Bearer " + key, json);
            if (r.status == 0) return error ("Couldn't reach OpenRouter. Check the connection");
            const auto j = r.json();
            if (r.status == 401) return error ("OpenRouter rejected the key");
            if (r.status == 402) return error ("This model needs credits. Pick a free model in Settings");
            if (r.status == 429) return error ("The free model is busy or rate-limited. Wait a minute or pick another");
            if (r.status != 200 || ! j["choices"].isArray())
                return error (j["error"]["message"].isString() ? j["error"]["message"].toString() : "OpenRouter answered " + String (r.status));
            auto* o = new DynamicObject();
            o->setProperty ("text", j["choices"][0]["message"]["content"].toString());
            return var (o);
        }, done);
    }

    // The free models on OpenRouter (prompt and completion both cost nothing): [{ id, name }].
    void freeModels (Done done)
    {
        run ([] {
            const auto r = send ("https://openrouter.ai/api/v1/models", {}, {});
            if (r.status != 200) return error ("Couldn't load OpenRouter's model list");
            Array<var> out;
            if (auto* list = r.json()["data"].getArray())
                for (const auto& m : *list)
                    if (m["pricing"]["prompt"].toString().getDoubleValue() == 0.0 && m["pricing"]["completion"].toString().getDoubleValue() == 0.0
                        && m["id"].toString().isNotEmpty())
                    {
                        auto* o = new DynamicObject();
                        o->setProperty ("id", m["id"]);
                        o->setProperty ("name", m["name"]);
                        out.add (var (o));
                    }
            auto* o = new DynamicObject();
            o->setProperty ("models", var (out));
            return var (o);
        }, done);
    }

    String model() const { const auto m = settings.getValue ("orModel"); return m.isNotEmpty() ? m : String (defaultModel); }

private:
    PropertiesFile& settings;
    std::shared_ptr<std::atomic<bool>> alive = std::make_shared<std::atomic<bool>> (true);
    // OpenRouter's router over its free models; Settings lists them to pick one.
    static constexpr const char* defaultModel = "openrouter/free";

    struct Response { int status = 0; MemoryBlock bytes; var json() const { return JSON::parse (bytes.toString()); } };
    static var error (const String& msg) { auto* o = new DynamicObject(); o->setProperty ("error", msg); return o; }

    static Response send (const String& url, const String& headers, const String& jsonBody)
    {
        Response r;
        auto u = URL (url);
        if (jsonBody.isNotEmpty()) u = u.withPOSTData (jsonBody);
        auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                        .withExtraHeaders (headers + (jsonBody.isEmpty() ? "" : "\r\nContent-Type: application/json")
                                           + "\r\nHTTP-Referer: https://github.com/rigsmith\r\nX-Title: Rigsmith")
                        .withConnectionTimeoutMs (60000)
                        .withStatusCode (&r.status);
        if (auto s = u.createInputStream (opts)) s->readIntoMemoryBlock (r.bytes);
        return r;
    }

    void run (std::function<var()> work, Done done)
    {
        auto flag = alive;
        Thread::launch ([work, done, flag] {
            auto r = work();
            MessageManager::callAsync ([r, done, flag] { if (*flag) done (r); });
        });
    }
};
} // namespace rig
