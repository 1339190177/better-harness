// Objective-C protocol declarations for the arch NSXPC service.
//
// ```text
//  Studio (Node)                   launchd service
//  ────────────                    ──────────────
//  harness-arch-client <NSXPC> harness-arch-xpc <stdio> harness-arch-host
// ```

#import <Foundation/Foundation.h>

@protocol ArchHostProtocol
- (void)forwardRequest:(NSData *)requestData reply:(void (^)(NSData *))reply;
@end

@protocol ArchClientProtocol
- (void)forwardRequest:(NSData *)requestData reply:(void (^)(NSData *))reply;
@end

// Generate the protocol objects that the Rust `extern "C"` declarations refer to.
// The Rust side declares:
//   unsafe extern "C" { fn harness_arch_host_protocol() -> *const AnyProtocol; }
//   unsafe extern "C" { fn harness_arch_client_protocol() -> *const AnyProtocol; }

id harness_arch_host_protocol(void) {
    return @protocol(ArchHostProtocol);
}

id harness_arch_client_protocol(void) {
    return @protocol(ArchClientProtocol);
}