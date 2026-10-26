#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalFiles, NSObject)
RCT_EXTERN_METHOD(pickFolder:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(writeToFolder:(NSString *)bookmark
                  filename:(NSString *)filename
                  contents:(NSString *)contents
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(deleteFromFolder:(NSString *)bookmark
                  filename:(NSString *)filename
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
