import Cocoa
import FinderSync

class FinderSync: FIFinderSync {
    // App icon bundled into the appex Resources by build.sh, shown next to
    // the context-menu item. Finder renders menu icons at 16x16.
    private static let menuIcon: NSImage? = {
        guard let url = Bundle(for: FinderSync.self).url(forResource: "MenuIcon", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 16, height: 16)
        return image
    }()

    override init() {
        super.init()
        // Monitor the whole filesystem so the menu item appears everywhere.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        switch menuKind {
        case .contextualMenuForItems, .contextualMenuForContainer:
            let item = NSMenuItem(
                title: "Open in Termifai",
                action: #selector(openInTermifai(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.image = Self.menuIcon
            menu.addItem(item)
        default:
            break
        }
        return menu
    }

    @objc func openInTermifai(_ sender: AnyObject?) {
        let controller = FIFinderSyncController.default()
        var folder: URL?

        if let selected = controller.selectedItemURLs(), let first = selected.first {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: first.path, isDirectory: &isDirectory),
               isDirectory.boolValue {
                folder = first
            } else {
                folder = first.deletingLastPathComponent()
            }
        } else {
            folder = controller.targetedURL()
        }

        guard let folderURL = folder else { return }

        var components = URLComponents()
        components.scheme = "termifai"
        components.host = "open-folder"
        components.queryItems = [URLQueryItem(name: "path", value: folderURL.path)]

        if let url = components.url {
            NSWorkspace.shared.open(url)
        }
    }
}
