#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(WidgetCache, NSObject)
RCT_EXTERN_METHOD(writeCache:(NSString *)json
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
