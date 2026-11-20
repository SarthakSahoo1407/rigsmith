// The capture library: NAM captures and cab IRs on this Mac, in libraryDir() (Dsp.h). Each file can
// have a sidecar "<file>.json" with where it came from (TONE3000 tone, creator, license), which the
// UI must show next to it. Files come from the user (import) or TONE3000 (Tone3000.h downloads).

#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include "Dsp.h"

namespace rig::library
{
inline bool isIr (const File& f) { return f.hasFileExtension ("wav;aif;aiff"); }

inline var entry (const File& f)
{
    auto meta = JSON::parse (f.withFileExtension (f.getFileExtension().substring (1) + ".json"));
    auto* o = meta.isObject() ? meta.getDynamicObject() : new DynamicObject();
    const String kind = isIr (f) ? "ir" : "nam";
    o->setProperty ("id", kind + "/" + f.getFileName());
    o->setProperty ("kind", kind);
    o->setProperty ("bytes", f.getSize());
    if (! o->hasProperty ("name")) o->setProperty ("name", f.getFileNameWithoutExtension());
    // A .nam file says what it is: use that when nothing better is known.
    if (kind == "nam" && ! o->hasProperty ("gear"))
    {
        const auto file = JSON::parse (f);
        const auto m = file["metadata"];
        if (m.isObject())
        {
            if (m["gear_type"].isString()) o->setProperty ("gear", m["gear_type"]);
            if (m["modeled_by"].isString() && ! o->hasProperty ("author")) o->setProperty ("author", m["modeled_by"]);
        }
    }
    return var (o);
}

inline var list()
{
    Array<var> out;
    for (const char* kind : { "nam", "ir" })
        for (const auto& f : libraryDir().getChildFile (kind).findChildFiles (File::findFiles, false, String (kind) == "nam" ? "*.nam" : "*.wav;*.aif;*.aiff"))
            out.add (entry (f));
    return out;
}

// A free file name in the library for `name`, with `ext`.
inline File freshFile (const String& kind, const String& name, const String& ext)
{
    return libraryDir().getChildFile (kind).getNonexistentChildFile (File::createLegalFileName (name).substring (0, 80), ext, false);
}

inline void writeMeta (const File& f, const var& meta)
{
    f.withFileExtension (f.getFileExtension().substring (1) + ".json").replaceWithText (JSON::toString (meta));
}

// Copies the user's files in. Returns the new entries; files that aren't captures or IRs are skipped.
inline var import (const Array<File>& files)
{
    Array<var> out;
    for (const auto& src : files)
    {
        if (! src.hasFileExtension ("nam;wav;aif;aiff") || src.getSize() > 64 * 1024 * 1024) continue;
        const String kind = isIr (src) ? "ir" : "nam";
        const auto dest = freshFile (kind, src.getFileNameWithoutExtension(), src.getFileExtension());
        if (! src.copyFileTo (dest)) continue;
        auto* meta = new DynamicObject();
        meta->setProperty ("name", src.getFileNameWithoutExtension());
        meta->setProperty ("source", "file");
        writeMeta (dest, var (meta));
        out.add (entry (dest));
    }
    return out;
}

inline bool remove (const String& id)
{
    const auto f = libraryFile (id);
    if (f == File() || ! f.existsAsFile()) return false;
    f.withFileExtension (f.getFileExtension().substring (1) + ".json").deleteFile();
    return f.deleteFile();
}
} // namespace rig::library
